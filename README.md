# IDFinder1 — automated rebuild

Lost & found ID matching app: report a lost or found ID, get automatically
matched on ID type + last-4-digits, and get notified by SMS once a match is
found. Rebuilt after the original manually-configured AWS setup was lost
when a free-trial account got suspended — this version is fully defined in
Terraform + GitHub Actions so that never happens again.

## Structure

```
frontend/           React + TypeScript + Vite app (Cognito auth, Amplify Hosting)
lambdas/backend/    DynamoDB CRUD + matching + SMS notification
lambdas/ocr_process/OCR proxy -- forwards ID photos to the OCR container
lambdas/save/       Uploads ID photos to S3
terraform/          All AWS infrastructure
.github/workflows/  CI/CD -- deploys on push to master
```

## How it works

1. Someone reports a lost or found ID (name on the ID, ID type, last 4
   digits, location, their own contact info + a required phone number).
2. The backend Lambda checks for a pending record of the opposite type
   with the same ID type + last-4-digits.
3. If found: both records are marked `matched`, and each party gets an SMS
   (via SNS) with the other's name and email so they can coordinate.
4. The public listing (`GET /IDfinder`) never returns contact info, matched
   or not — only the name on the ID, ID type, location, and status. This
   was a deliberate decision: anyone can browse without logging in, but
   nobody's email or phone is ever exposed through the API.
5. Reporting requires signing in (Cognito) via the report pages; browsing
   does not.

## Deploying

See **`GETTING_STARTED.md`** at the repo root -- push, `terraform init`,
`terraform apply`, done.

## What changed from the original app

- Added a required phone number to both report forms — needed for SMS
  match notifications, which didn't exist before.
- Fixed a bug where the report submission wasn't `await`ed.
- Split "name on the ID" from "who's reporting it" (`reporter_name` /
  `reporter_email` / `reporter_phone`) — a found-ID reporter isn't the ID's
  owner, so their contact info shouldn't be conflated with the name printed
  on the ID.
- Removed dead code (`Message.tsx`, an empty error component, an unused
  API client, unused `@aws-sdk` DynamoDB packages) and debug `console.log`s.
- Cognito config now reads from environment variables instead of hardcoded
  pool/client IDs, since Terraform provisions a new pool.
- Consolidated what were three separate API Gateway deployments into one
  HTTP API with three routes (`/IDfinder`, `/process`, `/save`) — simpler
  to manage as one Terraform-owned resource. If you'd rather keep them
  separate, that's a straightforward split in `terraform/lambda.tf`.
- `.env` is now git-ignored; real values are injected by Amplify Hosting at
  build time (see `terraform/amplify.tf`), not committed.

## Known trade-offs, worth revisiting later

- API Gateway CORS defaults to `*` (see `cors_allowed_origins` in
  `terraform/variables.tf`) to avoid a circular dependency between Amplify's
  generated domain and API Gateway's config on first apply. Tighten it to
  your real Amplify domain once you have a custom domain, if you want.
- The OCR container's ALB is internet-facing with no network-level
  restriction, since the OCR-process Lambda isn't in a VPC and can't be
  allow-listed by IP. It relies on the container's own `API_KEY` for its
  outbound calls, not inbound auth.
- No production SNS SMS access by default — see step 5 in `BOOTSTRAP.md`.
