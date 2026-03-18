import "server-only";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";

const logger = createScopedLogger("dharahil-client");

// DharaHIL decision types
export type DharaHILAction =
  | "ALLOW"
  | "APPROVED"
  | "DENY"
  | "REJECTED"
  | "REVISE_REQUESTED"
  | "EXPIRED"
  | "AUTO_ALLOWED"
  | "PENDING"
  | "ERROR";

export interface DharaHILContext {
  agentId: string;
  runId: string;
  stepId?: string;
  contextSummary: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  tags?: string[];
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface DharaHILRequest {
  toolName: string;
  toolArgs: Record<string, any>;
  context: DharaHILContext;
}

export interface DharaHILResponse {
  request_id: string;
  expires_at: string; // ISO 8601 timestamp
  status: string;
  action?: DharaHILAction;
}

export interface DharaHILDecision {
  action: DharaHILAction;
  revise_input?: string;
  reason?: string;
}

export class DharaHILClient {
  private baseUrl: string;
  private apiKey: string;
  private tenantId: string;
  private appId: string;
  private environment: string;

  constructor(config?: {
    baseUrl?: string;
    apiKey?: string;
    tenantId?: string;
    appId?: string;
    environment?: string;
  }) {
    // Use config or fall back to env vars
    this.baseUrl =
      config?.baseUrl ||
      process.env.DHARAHIL_BASE_URL ||
      "https://dharahil-gateway.sudiptadhara.in";
    this.apiKey =
      config?.apiKey ||
      process.env.DHARAHIL_API_KEY ||
      "dhara_sk_12f85b7abc1d1e23b83dd85c67e049271b91680edbc4d2787c59b42d8f83b6c9";
    this.tenantId =
      config?.tenantId ||
      process.env.DHARAHIL_TENANT_ID ||
      "0ff30ba6-44c0-4c1b-89e6-5936cca0cc29";
    this.appId =
      config?.appId ||
      process.env.DHARAHIL_APP_ID ||
      "69938d75-c4e7-4715-b575-0fb29da4b9ce";
    this.environment =
      config?.environment || process.env.DHARAHIL_ENVIRONMENT || "production";
  }

  /**
   * Submit an approval request to DharaHIL gateway
   */
  async beforeExecute(request: DharaHILRequest): Promise<DharaHILResponse> {
    logger.info("DharaHIL: Submitting approval request", {
      toolName: request.toolName,
      agentId: request.context.agentId,
      riskLevel: request.context.riskLevel,
    });

    try {
      const response = await fetch(`${this.baseUrl}/v1/requests`, {
        method: "POST",
        headers: {
          "X-DHARA-API-KEY": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenant_id: this.tenantId,
          app_id: this.appId,
          environment: this.environment,
          tool_name: request.toolName,
          tool_args: request.toolArgs,
          tool_args_redacted: request.toolArgs, // TODO: Implement redaction
          agent_id: request.context.agentId,
          run_id: request.context.runId,
          step_id: request.context.stepId || "step",
          context_summary: request.context.contextSummary,
          risk_level: request.context.riskLevel,
          tags: request.context.tags || [],
          idempotency_key:
            request.context.idempotencyKey ||
            `${request.toolName}_${Date.now()}`,
          metadata: request.context.metadata || {},
          webhook: {
            url: "",
            headers: {},
            decision_url: `${this.baseUrl}/v1/requests/${request.context.idempotencyKey || `${request.toolName}_${Date.now()}`}`,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("DharaHIL: Request submission failed", {
          status: response.status,
          error: errorText,
        });
        throw new SafeError(
          `DharaHIL request failed: ${response.status} ${errorText}`
        );
      }

      const data = (await response.json()) as DharaHILResponse;
      logger.info("DharaHIL: Request submitted successfully", {
        requestId: data.request_id,
        expiresAt: data.expires_at,
      });

      return data;
    } catch (error) {
      logger.error("DharaHIL: Failed to submit request", { error });
      // Fail-safe: Return DENY on any error
      throw new SafeError(
        "DharaHIL gateway unreachable - action denied for safety"
      );
    }
  }

  /**
   * Poll for a decision with dynamic TTL from gateway response
   */
  async pollForDecision(
    requestId: string,
    expiresAt: string,
    pollIntervalMs = 3000
  ): Promise<DharaHILDecision> {
    const expiresAtTime = new Date(expiresAt).getTime();
    const now = Date.now();
    const dynamicTimeoutMs = expiresAtTime - now;

    logger.info("DharaHIL: Starting polling", {
      requestId,
      expiresAt,
      timeoutMs: dynamicTimeoutMs,
      pollIntervalMs,
    });

    if (dynamicTimeoutMs <= 0) {
      logger.warn("DharaHIL: Request already expired", {
        requestId,
        expiresAt,
      });
      return { action: "EXPIRED" };
    }

    const startTime = Date.now();

    while (Date.now() - startTime < dynamicTimeoutMs) {
      try {
        const response = await fetch(
          `${this.baseUrl}/v1/requests/${requestId}`,
          {
            headers: {
              "X-DHARA-API-KEY": this.apiKey,
            },
          }
        );

        if (!response.ok) {
          logger.error("DharaHIL: Failed to poll decision", {
            requestId,
            status: response.status,
          });
          // Continue polling on transient errors
          await this.sleep(pollIntervalMs);
          continue;
        }

        const data = (await response.json()) as any;

        // Check if we have a decision
        // Gateway returns: status (PENDING/APPROVED/REJECTED/etc) and last_decision (approve/reject/etc)
        if (data.status && data.status !== "PENDING") {
          logger.info("DharaHIL: Decision received", {
            requestId,
            status: data.status,
            last_decision: data.last_decision,
          });

          // Map gateway status to our action enum
          let action: DharaHILAction;
          if (data.status === "APPROVED" || data.last_decision === "approve") {
            action = "APPROVED";
          } else if (data.status === "REJECTED" || data.last_decision === "reject") {
            action = "DENIED";
          } else if (data.last_decision === "revise") {
            action = "REVISE_REQUESTED";
          } else {
            action = data.status as DharaHILAction;
          }

          return {
            action,
            revise_input: data.last_decision_revise_input,
            reason: data.last_decision_note,
          };
        }

        // Still pending, wait before next poll
        logger.trace("DharaHIL: Still pending, continuing to poll", {
          requestId,
        });
        await this.sleep(pollIntervalMs);
      } catch (error) {
        logger.error("DharaHIL: Polling error", { requestId, error });
        // Continue polling on transient errors
        await this.sleep(pollIntervalMs);
      }
    }

    // Timeout reached
    logger.warn("DharaHIL: Polling timeout reached", {
      requestId,
      timeoutMs: dynamicTimeoutMs,
    });
    return { action: "EXPIRED" };
  }

  /**
   * Combined submit + poll workflow
   */
  async runApprovalLoop(request: DharaHILRequest): Promise<DharaHILDecision> {
    try {
      // Submit request and get dynamic TTL
      const response = await this.beforeExecute(request);

      // Poll for decision using the TTL from gateway
      const decision = await this.pollForDecision(
        response.request_id,
        response.expires_at
      );

      return decision;
    } catch (error) {
      logger.error("DharaHIL: Approval loop failed", { error });
      // Fail-safe: DENY on any error
      return { action: "ERROR", reason: String(error) };
    }
  }

  /**
   * Check if action should proceed based on decision
   */
  shouldProceed(decision: DharaHILDecision): boolean {
    return (
      decision.action === "ALLOW" ||
      decision.action === "APPROVED" ||
      decision.action === "AUTO_ALLOWED"
    );
  }

  /**
   * Check if action should be revised
   */
  shouldRevise(decision: DharaHILDecision): boolean {
    return decision.action === "REVISE_REQUESTED";
  }

  /**
   * Check if action was denied
   */
  wasDenied(decision: DharaHILDecision): boolean {
    return (
      decision.action === "DENY" ||
      decision.action === "REJECTED" ||
      decision.action === "EXPIRED" ||
      decision.action === "ERROR"
    );
  }

  /**
   * Helper to sleep for polling
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance for global use
export const dharahilClient = new DharaHILClient();
