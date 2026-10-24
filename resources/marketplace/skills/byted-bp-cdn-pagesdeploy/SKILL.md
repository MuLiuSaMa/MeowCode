---
name: byted-bp-cdn-pagesdeploy
description: One-click deployment of static websites to BytePlus Edge Pages platform, supporting auto project creation, update deployment, custom domain binding, and CDN acceleration. Includes guided onboarding for new users without a BytePlus account.
---

# Pages Deploy Skill

## Overview

One-click deployment of static website code to BytePlus Edge Pages platform. Designed for use in Coding Agents (Cursor, Claude Code, Trae, Windsurf, etc.) to quickly complete hosting, building, and CDN integration after generating static web pages.

## Scenarios

### Scene A: Existing BytePlus User (has account + CDN enabled)

User already has a BytePlus account with CDN service enabled. Only needs to provide AK/SK to deploy.

**Flow**: Configure AK/SK → Deploy

### Scene B: New User Onboarding (no BytePlus account)

User is developing in an AI IDE (Cursor, Claude Code, Trae, Windsurf, etc.), has completed web app development, and wants to deploy. They don't have a BytePlus account yet.

**Flow**: Register Account → Get AK/SK → Activate CDN → Deploy

---

## Scene Detection

When the skill is invoked, determine which scene applies:

1. **Check if AK/SK already exists**: Look for `secrets/byteplus.json` or environment variables `BYTEPLUS_ACCESS_KEY` / `BYTEPLUS_SECRET_KEY`, or check if `nest pages list` succeeds.
2. **If AK/SK exists and works** → Scene A (go directly to deployment)
3. **If no AK/SK found** → Ask user: "Do you already have a BytePlus account?"
   - Yes → Guide them to get AK/SK (Scene A, Step 2 of Prerequisites)
   - No → Scene B (full onboarding flow below)

---

## Scene B: New User Onboarding Flow

This is a multi-step dialogue flow. The Agent guides the user through each step, waiting for confirmation before proceeding to the next.

### Step 1: Register BytePlus Account

Tell the user:

> To deploy your site, you'll need a BytePlus account. Let me open the registration page for you.
>
> **What you need to complete:**
> 1. Sign up at BytePlus
> 2. Complete personal identity verification
> 3. Add a credit card for billing
>
> Once you've finished registration, come back and let me know.

**Action**: Open the registration URL in the user's browser:

```bash
bash /path/to/scripts/onboard.sh open-browser "https://signin.byteplus.com/auth/signup"
```

Then **wait for user to confirm** they have completed registration before proceeding.

### Step 2: Guide AK/SK Creation

Tell the user:

> Great! Now you need to create an Access Key for API access.
>
> Let me open the IAM Access Key Management page. There you can:
> 1. Click "Create Access Key"
> 2. Copy the **Access Key ID** and **Secret Access Key**
>
> **Example format:**
> - Access Key ID: `AKLTMjY2MDxxxxxxxxxxxxxxxxxxxxxx`
> - Secret Access Key: `T1dHVnxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
>
> Please paste your Access Key ID and Secret Access Key here once you have them.

**Action**: Open the IAM page in the user's browser:

```bash
bash /path/to/scripts/onboard.sh open-browser "https://console.byteplus.com/iam/keymanage"
```

Then **wait for user to provide AK/SK**.

### Step 3: Save AK/SK Configuration

Once the user provides AK and SK:

```bash
bash /path/to/scripts/onboard.sh save-credentials "<access_key>" "<secret_key>"
```

This configures the nest CLI with the provided credentials.

### Step 4: Activate CDN Service

Tell the user:

> Now I need to activate BytePlus CDN service on your account. This enables the Edge Pages hosting platform.
>
> - **Service**: BytePlus CDN (pay-as-you-go billing)
> - **Region**: Overseas acceleration
> - **Cost**: Pay only for actual traffic usage
>
> Shall I proceed with activating CDN? (Yes/No)

**Wait for user authorization**, then execute:

```bash
bash /path/to/scripts/onboard.sh subscribe-cdn "<access_key>" "<secret_key>"
```

If successful, tell the user:

> CDN service activated! Pages platform is now ready. Let's deploy your site.

If it fails, show the error and suggest the user manually enable CDN at `https://console.byteplus.com/cdn`.

### Step 5: Proceed to Deployment

Onboarding is complete. Continue with the normal deployment flow (same as Scene A):

```bash
bash /path/to/scripts/deploy.sh --name <project-name> --dir <site-directory>
```

---

## Scene A: Direct Deployment (Existing User)

### Prerequisites

1. **AK/SK Configuration**: Requires BytePlus Access Key and Secret Key
   - Mira client: Stored in `secrets/byteplus.json`, format: `{"access_key": "xxx", "secret_key": "xxx"}`
   - Manual config: `nest config set -g cloud.access_key YOUR_AK && nest config set -g cloud.secret_key YOUR_SK`
2. **Static site directory**: A directory containing `index.html`

### Full Deployment (Auto-detects create vs. update)

```bash
# Auto-detect: creates project if not exists, updates deployment if exists
bash /path/to/scripts/deploy.sh --name my-site --dir ./dist

# Specify description and acceleration region
bash /path/to/scripts/deploy.sh --name my-site --dir ./dist --desc "AI generated site" --region global

# Bind custom domain
bash /path/to/scripts/deploy.sh --name my-site --dir ./dist --domain www.example.com
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--name` | Yes | Pages project name |
| `--dir` | Yes | Static site resource directory (must contain index.html) |
| `--desc` | No | Project description |
| `--region` | No | Acceleration region: `global` / `chinese_mainland` / `outside_chinese_mainland` |
| `--domain` | No | Custom domain |
| `--build-cmd` | No | Build command to run before deployment (e.g. `npm run build`) |
| `--secrets-file` | No | AK/SK config file path (default: secrets/byteplus.json) |

### Other Operations

```bash
# List projects
bash /path/to/scripts/manage.sh list

# Show project details
bash /path/to/scripts/manage.sh get --pages p-xxx

# Show deployment history
bash /path/to/scripts/manage.sh deployments --pages p-xxx

# Local preview
bash /path/to/scripts/manage.sh serve --dir ./dist --port 8080

# Domain management
bash /path/to/scripts/manage.sh domain-list --pages p-xxx
bash /path/to/scripts/manage.sh domain-add --pages p-xxx --domain www.example.com
bash /path/to/scripts/manage.sh domain-verify --pages p-xxx --domain www.example.com

# Offline / Delete
bash /path/to/scripts/manage.sh offline --pages p-xxx
bash /path/to/scripts/manage.sh delete --pages p-xxx
```

---

## Complete Workflow

### New User (Scene B)
```
Step 0: Open browser → Register BytePlus account
Step 1: User confirms registration complete
Step 2: Open browser → IAM Access Key Management
Step 3: User provides AK/SK → Save credentials
Step 4: User authorizes → Activate CDN service via API
Step 5: Deploy → deploy.sh --name xxx --dir ./my-site
Step 6: Check domain → manage.sh get --pages p-xxx
Step 7: Bind domain (optional) → deploy.sh --name xxx --dir ./my-site --domain www.example.com
```

### Existing User (Scene A)
```
Step 0: Environment Setup (one-time) → Install CLI + Configure AK/SK
Step 1: Coding Agent generates code → ./my-site/
Step 2: Local preview → nest pages serve ./my-site
Step 3: Deploy → deploy.sh --name xxx --dir ./my-site
Step 4: Check domain → manage.sh get --pages p-xxx
Step 5: Bind domain → deploy.sh --name xxx --dir ./my-site --domain www.example.com
Step 6: Iterative update → deploy.sh --name xxx --dir ./my-site
Step 7: Manage → manage.sh list / deployments / offline
```

## Notes

- China mainland production does not provide a default domain; a custom domain must be bound for access
- CLI package name is `@byteplus/nest` (not `@byted/nest`)
- CDN propagation takes 1-5 minutes after deployment
- Custom domains require adding a CNAME record at your DNS provider
- Scene B onboarding is a conversational flow — the Agent must wait for user confirmation at each step before proceeding
- The `SubscribeCdnService` API uses BytePlus OpenAPI V4 signature, Service=CDN, Version=2021-03-01
