# Getting started

This is the only doc you need to go from "zip file" to "deployed app."

## 0. One-time things to have ready

- AWS CLI configured locally (`aws configure`) -- you already have this.
- Terraform installed locally -- you already have this.
- A GitHub personal access token with `repo` + `admin:repo_hook` scopes
  (Amplify needs this to pull your repo). Create one at
  github.com/settings/tokens.
- The API key your `ericsonasamoah/ocr123` container needs for its own
  outbound calls.

Don't put either of those in a file that gets committed. You'll export
them as environment variables in step 3.

## 1. Push this code to your repo

```bash
git add .
git commit -m "Automated rebuild: terraform + lambdas + redesigned frontend"
git push origin master
```

The `.gitignore` at the repo root already excludes `node_modules`,
Terraform state/build files, and `.env` files, so this won't dump
anything unnecessary into GitHub.

## 2. Terraform state backend

Already wired up for you in `terraform/versions.tf`, pointing at your
existing bucket (`local-shop-design-app-tfstate-258506450105`, in
`us-east-1` -- that's just where the *state file* lives; the app's actual
resources all deploy to `eu-north-1`). Nothing to change here unless you
want a different bucket.

## 3. Deploy

From the `terraform/` folder:

```bash
cd terraform

# Windows PowerShell:
$env:TF_VAR_github_access_token = "<your GitHub PAT>"
$env:TF_VAR_ocr_api_key = "<your OCR container API key>"

# macOS/Linux:
export TF_VAR_github_access_token=<your GitHub PAT>
export TF_VAR_ocr_api_key=<your OCR container API key>

terraform init
terraform apply
```

Type `yes` when prompted. This creates everything: VPC, the OCR
container on ECS, DynamoDB, S3, Cognito, API Gateway, Amplify Hosting
wired to your repo, and the GitHub OIDC role for future automated
deploys.

**If you hit `EntityAlreadyExists` on the GitHub OIDC provider** -- that
means your AWS account already has one from another project (an account
can only have one, total, regardless of which repo). Fix:

```bash
aws iam list-open-id-connect-providers
```

Find the ARN, then re-run with:

```bash
terraform apply \
  -var="create_github_oidc_provider=false" \
  -var="existing_github_oidc_provider_arn=<arn from above>"
```

When it finishes, check the outputs:

```bash
terraform output
```

Your app is live at `terraform output amplify_default_domain`.

## 4. (Optional) Hand off future deploys to GitHub Actions

You don't need this to have a working app -- step 3 already deployed it.
This just means future `git push` automatically re-applies Terraform
instead of you running it locally.

```bash
terraform output github_deploy_role_arn
```

Add three repo secrets (Settings -> Secrets and variables -> Actions):

- `AWS_DEPLOY_ROLE_ARN` -- the ARN from the command above
- `GH_ACCESS_TOKEN` -- the same PAT from step 0
- `OCR_API_KEY` -- the same key from step 0

From then on, `.github/workflows/deploy.yml` runs on every push to
`master`.

## 5. SMS is off by default

`terraform/variables.tf`'s `sms_enabled` defaults to `false`, so you can
test reporting and matching end-to-end (records still get marked
`matched` correctly) without needing SNS sandbox approval first. The
backend Lambda logs what it *would* have sent instead of calling SNS.

Once you're ready for real texts:

```bash
terraform apply -var="sms_enabled=true"
```

(or set it permanently in a `.tfvars` file -- see the note on those in
`.gitignore`, they're excluded from git on purpose since they can hold
secrets).

## 6. SNS SMS sandbox

New AWS accounts start in the SNS SMS sandbox -- you can only text
pre-verified numbers until AWS approves production access. Request it
early: Console -> SNS -> Text messaging (SMS) -> "Exit sandbox." Approval
can take a day or two. Do this before flipping `sms_enabled` to `true`.

## Troubleshooting

- **A `local-exec` step fails on Windows with a PowerShell parser
  error** -- this was a bug in an earlier version of this package (the
  script used Bash-only syntax). Fixed now; if you still see it, you have
  an old copy.
- **Amplify build fails** -- check the build logs in the Amplify console;
  most likely cause is a missing/incorrect GitHub PAT.
- **CORS errors in the browser** -- `terraform/variables.tf`'s
  `cors_allowed_origins` defaults to `"*"` on purpose, to avoid a circular
  dependency on first apply. If you've since narrowed it and are seeing
  CORS errors, double check it includes your actual Amplify domain.
