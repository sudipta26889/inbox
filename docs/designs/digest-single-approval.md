# Digest: one approval per digest, one send

## Problem (2026-11-19)
The digest cron runs every 30 minutes. A run that sends the digest by the user's own mailbox waits for a
DharaHIL decision inside `sendEmailWithHtml` → `requireSendApproval`, which can take up to the card's TTL
(about 60 minutes). Three things combine:

1. `claimPendingDigests` marks the digest rows `PROCESSING` with a **10-minute lease**
   (`utils/digest/claim-pending-digests.ts`). The human wait outlives it.
2. The schedule only moves forward after a send, so the next run still sees the digest as due, and it
   **reclaims the stale `PROCESSING` rows** and builds the same digest again.
3. The send passes **no `operationId`**, so the DharaHIL idempotency key ends in `Date.now()`
   (`askReviewer` in `utils/mail/send-approval.ts`). Every run raises a **new card**.

The claim is re-checked (`renewDigestClaim`) *before* `sendDigest`, never after the decision. The first
run kept polling its card; an Approve on it would have sent the digest a second time. One card per run
for as long as nobody answers: 03:59, 04:29, 04:59, …

## Fix
1. **A later run does not start while a digest is awaiting approval.** Before claiming, if the account
   has a `PROCESSING` digest whose lease is still live, the run returns ("digest in progress") without
   claiming and without moving the schedule.
2. **The lease outlives the approval wait.** `PROCESSING_LEASE_MS` becomes 75 minutes (card TTL is
   60). A crashed run now blocks the digest for up to 75 minutes instead of 10; acceptable for a daily
   digest.
3. **Approve first, then check the claim, then send.** The self-send in `sendNotificationEmail` takes an
   optional `operationId` and `beforeSend` hook. With them it calls `approveSendOperation`
   (operationId = `digest_<sha256 of the sorted claimed digest ids>`, payload hash over to/subject/html),
   then `beforeSend()`, then `sendEmailWithHtml(edited body, { approval })`, which needs no second card.
   The digest route's `beforeSend` is `renewDigestClaim`; if the claim is lost, it throws
   `DigestClaimLostError`, nothing is sent, and the route returns "Digest processing claim was lost"
   without marking rows FAILED. So a late Approve on an orphaned card is ignored.
4. The stable `operationId` also makes a retry with identical content join the open card at the gateway
   rather than raise a new one.

Other callers of `sendNotificationEmail` are unchanged (no `operationId` → old path).

5. **A rejection is recorded as declined, not as a failed delivery.** New `DigestStatus.DECLINED`
   (migration). When the email channel throws `SendNotApprovedError` (reject, expire, revise), the route
   marks the claimed rows DECLINED, advances the schedule for this occurrence, logs at info
   ("Digest declined by reviewer", with the decision), and does not call `captureException` or return an
   error. `send-digest.ts` rethrows `SendNotApprovedError` like `DigestClaimLostError` instead of logging
   "Digest delivery channel failed". The provider wrapper (`utils/email/provider.ts`) does not log
   "Email provider operation failed" for `SendNotApprovedError`. Without (5) a "no" leaves the schedule due,
   so every 30 minutes a run that finds newly arrived items raises a new card for them.

## Not changed
- Cancelling an orphaned card at the gateway: with (3) its approval cannot send; it expires on its own.
- The Resend path (when `RESEND_API_KEY` is set) is not gated by DharaHIL; production self-sends.
- The `Digest` table: rows are created when items arrive (earlier days) and are updated to `SENT` with
  `sentAt`; a send creates no row. Count by `sentAt`, not `createdAt`.

## Checks
- Unit: a second run while a live `PROCESSING` digest exists claims nothing, asks nothing, leaves the
  schedule alone.
- Unit: approval granted after the claim was lost → provider send not called, rows not changed.
- Unit: normal path → one approval, one send with the issued approval, rows `SENT`.
- Unit: email channel rejected → rows DECLINED, schedule advanced, no error logged or returned.
- Existing digest and send-approval tests pass.
