[![](apps/web/app/opengraph-image.png)](https://inbox.sudiptadhara.in)

<p align="center">
  <a href="https://inbox.sudiptadhara.in">
    <h1 align="center">Inbox - your 24/7 AI email assistant</h1>
  </a>
  <p align="center">
    Organizes your inbox, pre-drafts replies, and tracks follow‑ups. Open source alternative to Fyxer, but more customisable and secure.
    <br />
    <a href="https://inbox.sudiptadhara.in">Website</a>
    ·
    <a href="https://inbox.sudiptadhara.in/discord">Discord</a>
    ·
    <a href="https://github.com/elie222/inbox/issues">Issues</a>
  </p>
</p>

<div align="center">

![Stars](https://img.shields.io/github/stars/elie222/inbox?labelColor=black&style=for-the-badge&color=2563EB)
![Forks](https://img.shields.io/github/forks/elie222/inbox?labelColor=black&style=for-the-badge&color=2563EB)

<a href="https://trendshift.io/repositories/6400" target="_blank"><img src="https://trendshift.io/api/badge/repositories/6400" alt="elie222%2Finbox | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

[![Vercel OSS Program](https://vercel.com/oss/program-badge.svg)](https://vercel.com/oss)

</div>

## Mission

To help you spend less time in your inbox, so you can focus on what matters most.

<br />

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Felie222%2Finbox&env=AUTH_SECRET,GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET,MICROSOFT_CLIENT_ID,MICROSOFT_CLIENT_SECRET,EMAIL_ENCRYPT_SECRET,EMAIL_ENCRYPT_SALT,UPSTASH_REDIS_URL,UPSTASH_REDIS_TOKEN,GOOGLE_PUBSUB_TOPIC_NAME,DATABASE_URL,NEXT_PUBLIC_BASE_URL)

## Features

- **AI Personal Assistant:** Organizes your inbox and pre-drafts replies in your tone and style.
- **Cursor Rules for email:** Explain in plain English how your AI should handle your inbox.
- **Reply Zero:** Track emails to reply to and those awaiting responses.
- **Bulk Unsubscriber:** One-click unsubscribe and archive emails you never read.
- **Bulk Archiver:** Clean up your inbox by bulk archiving old emails.
- **Cold Email Blocker:** Auto‑block cold emails.
- **Email Analytics:** Track your activity and trends over time.
- **Meeting Briefs:** Get personalized briefings before every meeting, pulling context from your email and calendar.
- **Smart Filing:** Automatically save email attachments to Google Drive or OneDrive.


Learn more in our [docs](https://inbox.sudiptadhara.in/docs).

## Feature Screenshots

| ![AI Assistant](.github/screenshots/email-assistant.png) |        ![Reply Zero](.github/screenshots/reply-zero.png)        |
| :------------------------------------------------------: | :-------------------------------------------------------------: |
|                      _AI Assistant_                      |                          _Reply Zero_                           |
|  ![Gmail Client](.github/screenshots/email-client.png)   | ![Bulk Unsubscriber](.github/screenshots/bulk-unsubscriber.png) |
|                      _Gmail client_                      |                       _Bulk Unsubscriber_                       |

## Demo Video

[![Inbox demo](/video-thumbnail.png)](http://www.youtube.com/watch?v=hfvKvTHBjG0)

## Built with

- [Next.js](https://nextjs.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Prisma](https://www.prisma.io/)
- [Upstash](https://upstash.com/)
- [Turborepo](https://turbo.build/)
- [Popsy Illustrations](https://popsy.co/)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=elie222/inbox&type=Date)](https://www.star-history.com/#elie222/inbox&Date)

## Feature Requests

To request a feature open a [GitHub issue](https://github.com/elie222/inbox/issues), or join our [Discord](https://inbox.sudiptadhara.in/discord).

## Getting Started

We offer a hosted version of Inbox at [inbox.sudiptadhara.in](https://inbox.sudiptadhara.in).

### Self-Hosting

The fastest way to self-host Inbox is with the CLI:

> **Prerequisites**: [Docker](https://docs.docker.com/engine/install/) and [Node.js](https://nodejs.org/) v24+

```bash
npx @inbox/cli setup      # One-time setup wizard
npx @inbox/cli start      # Start containers
```

Open http://localhost:3000

For complete self-hosting instructions, production deployment, OAuth setup, and configuration options, see our **[Self-Hosting Docs](https://inbox.sudiptadhara.in/docs/hosting/quick-start)**.

### Local Development

> **Prerequisites**: [Docker](https://docs.docker.com/engine/install/), [Node.js](https://nodejs.org/) v24+, and [pnpm](https://pnpm.io/) v10+

```bash
git clone https://github.com/elie222/inbox.git
cd inbox
docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis
pnpm install
npm run setup                                     # Interactive env setup
cd apps/web && pnpm prisma migrate dev && cd ../..
pnpm dev
```

Open http://localhost:3000

See the **[Contributing Guide](https://inbox.sudiptadhara.in/docs/contributing)** for more details including devcontainer setup.

## Contributing

View open tasks in [GitHub Issues](https://github.com/elie222/inbox/issues) and join our [Discord](https://inbox.sudiptadhara.in/discord) to discuss what's being worked on.

Docker images are automatically built on every push to `main` and tagged with the commit SHA (e.g., `elie222/inbox:abc1234`). The `latest` tag always points to the most recent main build. Formal releases use version tags (e.g., `v2.26.0`).
