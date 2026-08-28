# Changelog

Running record of changes made to this project, and the reasoning behind them.

Most valuable for what git doesn't record: terraform applies, deployment state,
AWS console actions, and decisions made *not* to do something.

---

## 2026-08-28

### Fixed: image upload always failed ("Failed to process")

- **terraform/variables.tf** — `ocr_container_port` 8000 → 8080. Root cause of
  the upload failure. The `ericsonasamoah/ocr123` container runs gunicorn on
  `0.0.0.0:8080` (confirmed in the `/ecs/idfinder1-ocr` CloudWatch logs), but
  the target group, security group and port mapping all pointed at 8000. Health
  checks hit a closed port, the ALB returned 502, and ECS killed and replaced
  the task on a loop. The container itself was never broken.

### Fixed: the three issues from the 2026-08-28 review

- **lambdas/backend/idfinder_backend.py** — dropped `id_number_hint` from
  `PUBLIC_FIELDS`. It doubles as the match key, so publishing it let anyone
  read a pending record's last-4, POST a forged opposite-type record with their
  own phone, and be texted the other party's name and email — while also
  burning the real record's `pending` status. Still stored, still used for
  matching, no longer broadcast.
- **terraform/iam.tf** — replaced the hardcoded OIDC subject
  (`repo:owner@84795350/repo@1335494099:...`, a shape GitHub never issues) with
  the documented `repo:${var.github_repo}:ref:refs/heads/${var.github_branch}`.
  CI could not assume the deploy role at all until this was corrected.
- **terraform/amplify.tf** — added `lifecycle { ignore_changes =
  [environment_variables] }`. The `null_resource` CLI shim sets 8 env vars;
  Terraform declared 4. Every apply after the first stripped the
  `VITE_COGNITO_*` vars back off without re-running the shim, silently breaking
  sign-in.

### Correctness

- **backend** — `handle_list` now paginates on `LastEvaluatedKey` (capped at
  500 records). A single `scan()` stops at 1MB, so the listing was silently
  truncating with no error. Also switched the filter from `Key` to `Attr`.
- **backend** — SMS failures no longer fail the request. Both records are
  already written and marked matched before SNS is called, so an exception
  there returned a 500 for a report that had actually succeeded, prompting a
  retry and a duplicate.
- **backend** — match claim now uses a `ConditionExpression` on
  `status = pending`, so two concurrent POSTs can't both claim the same record.
- **backend** — `id_number_hint` is normalised to digits-only last-4 and is now
  required; previously an unnormalised or empty hint silently made a record
  unmatchable forever.
- **frontend + backend** — the S3 key from `/save` is now threaded into the
  record as `photo_key`. It was being discarded, so every uploaded ID photo sat
  in S3 unlinked to any report until the 180-day lifecycle rule deleted it.
- **frontend** — "Last 4 Digits *" on the found form had the asterisk but no
  `required`; both forms now enforce it.
- **terraform/lambda.tf** — `process` Lambda timeout 65s → 29s, and the OCR
  client timeout 60s → 25s. API Gateway caps HTTP API integrations at ~30s, so
  the longer values were unreachable.

### Security

- **ocr_backend.py / idfinder_save.py** — stopped returning `str(e)` to
  callers; the detail is logged instead. Both endpoints are public and were
  leaking the internal ALB hostname, bucket names and library internals.

### Cleanup

- **terraform/lambda.tf** — declared the three Lambda log groups at 14-day
  retention (they existed with "never expire"). Uses `import` blocks to adopt
  the groups Lambda already created; those blocks can be deleted after the
  first successful apply.
- **frontend** — removed GitHub Pages leftovers (`homepage`, `build:ghpages`,
  `predeploy`, `deploy`, the `gh-pages` dep, and the `ghpages` base mode in
  `vite.config.ts`); regenerated `package-lock.json` so Amplify's `npm ci`
  stays consistent. Deleted unimported `App.css` and `react.svg`.
- **.github/workflows/deploy.yml** — `terraform fmt -check` no longer has
  `continue-on-error: true`. Annotated the OIDC debug step as temporary rather
  than removing it, so the next run still prints the real subject claim for
  verification.

### Not done — decisions deferred

- **ALB is still plain HTTP.** ID photos cross the public internet unencrypted
  between the Lambda and the container. Fixing it needs an ACM certificate and
  a domain, which is a larger change than the rest of this batch.
- **`/save` and `/process` are still unauthenticated.** Anyone can push 8MB
  blobs into the bucket or use the OCR container for free.
- **`POST /IDfinder` is still unauthenticated.** Withholding the last-4 removes
  the easy harvest, but a brute-force over ~10k values per ID type still works.
  Closing it properly means either a Cognito authorizer (frontend must then
  send a JWT) or mutual confirmation before contact details are released — a
  design call, not a bug fix.
- **Deploy role still has `iam:PassRole` on `*` plus `lambda:*`**, which is
  effectively admin.
- **Applied via CI, not locally.** `TF_VAR_github_access_token` and
  `TF_VAR_ocr_api_key` were not available in this environment, so the apply was
  left to the GitHub Actions workflow. See the recovery note below for what
  landed and what did not.

### Partial apply recovery (same day, after the first push)

- **terraform/alb.tf** — target group switched from `name` to
  `name_prefix = "idfocr"` with `create_before_destroy = true`. The first CI
  apply got most of the way through (log groups imported at 14-day retention,
  both Lambdas redeployed, OCR security group moved to 8080) and then failed on
  the target group: `port` is ForceNew, so changing `ocr_container_port`
  replaces the resource, but with a fixed name the replacement deadlocks — the
  old group can't be destroyed while the listener and ECS service reference it,
  and creating first collides on the duplicate name.
- **State at that point was split**: SG on 8080, target group and task
  definition still on 8000, so the ALB health check changed symptom from
  `FailedHealthChecks` to `Target.Timeout` (SG now blocks 8000). Equally broken,
  not worse.
- **Confirmed working**: the OIDC fix. CI authenticated and ran the apply, and
  the live trust policy now reads
  `repo:ericsonasamoah3/IDFinder-Automated:ref:refs/heads/master`. The state
  lock error seen locally was a transient collision with that CI run, not a
  stale lock — the `.tflock` object was already gone.

### Reverted: the OIDC subject "fix" was wrong

- **terraform/iam.tf** — restored the original hardcoded subject
  `repo:ericsonasamoah3@84795350/IDFinder-Automated@1335494099:ref:refs/heads/master`.
  Changing it to the stock `repo:OWNER/REPO:ref:refs/heads/BRANCH` broke CI
  authentication outright.
- **Why the earlier reasoning was wrong**: the stock format is the *default*
  subject shape, but this repository has a customised OIDC subject claim
  template configured on the GitHub side, which splices the repository-owner ID
  and repository ID in with "@". The warning comment already in the file was
  correct and should not have been overridden.
- **How it presented**: run 1 (8e018fd) authenticated using the old, still-live
  policy and then applied the change — so it looked like proof the new value
  worked. Run 2 (78ecd5d) failed at "Configure AWS credentials (OIDC)" with the
  new value live. Both Aug 16 runs had also succeeded with the "@" value.
- **Recovery requires a manual step**: CI cannot repair its own trust policy, so
  the live role must be corrected with `aws iam update-assume-role-policy`
  before any further CI run can authenticate.

### Recovery completed

- **Live trust policy restored manually** (`aws iam update-assume-role-policy`),
  putting the `@`-style subject back on `idfinder1-github-deploy`. Confirmed
  live. This had to be done outside CI because CI cannot authenticate to repair
  its own trust policy.
- **.github/workflows/deploy.yml** — removed the temporary OIDC debug step now
  that the correct subject is confirmed; left a comment explaining how to
  re-add it and why this repo's subject claim is non-standard.

### Image upload: two further bugs behind the port mismatch

Once the port was fixed and the container was finally reachable, `/process`
returned 500 and two more faults surfaced that the port problem had been
masking.

- **terraform/lambda.tf** — `CONTAINER_URL` now points at `/invocations`, not
  `/`. The ocr123 image is a SageMaker-style inference container (gunicorn on
  8080, `/opt/program`): it serves `GET /ping` for health and `POST
  /invocations` for work. Probing through the ALB confirmed `/` → 404,
  `/ping` → 200, `/invocations` → 405 on GET. The Lambda was POSTing to `/`
  and getting a 404 back.
- **terraform/ecs.tf** — `value = trimspace(var.ocr_api_key)` on the SSM
  parameter. The stored key carried a trailing newline, which rode through into
  the container's `Authorization: Bearer ...` header; httpx rejected it with
  `LocalProtocolError: Illegal header value` and the Groq call failed before
  leaving the container.
- **terraform/alb.tf** — health check moved from `/` (matcher `200-499`) to
  `/ping` (matcher `200`). The old check passed on the container's 404, so it
  proved only that something was listening, not that the app was healthy.

### SECURITY: Groq API key leaked into CloudWatch

- The container's stack trace printed the full `Bearer` token into the
  `/ecs/idfinder1-ocr` log group, which retains 14 days and is readable by
  anyone with CloudWatch access. **The Groq key must be rotated**, and the new
  value set in the `OCR_API_KEY` GitHub secret. `trimspace` prevents the
  newline recurring but does nothing about the already-exposed key.
- **terraform/ecs.tf** — task definition now carries an `API_KEY_VERSION`
  environment variable pinned to `aws_ssm_parameter.ocr_api_key.version`. The
  container reads `API_KEY` from SSM once at task start, so changing the SSM
  value alone produced no new task definition revision, ECS never redeployed,
  and the task kept serving with the stale key. This makes any key change roll
  the task definition and force a fresh deployment. Also means rotating the
  Groq key will actually take effect on the next apply.

### Verified working — image upload fixed

End-to-end confirmation at 17:55 UTC, after CI runs `029dd26` and `3419c7d`:

- `POST /process` with a test JPEG returns
  `{"success": true, "name_on_id": "", "id_type": "other", "id_number_hint": ""}`.
  Empty fields are correct for a 1x1 blank test image; `success: true` means the
  whole chain runs (API Gateway -> Lambda -> ALB -> container -> Groq).
- ECS task definition rolled 8 -> 9 via the `API_KEY_VERSION` pin, SSM parameter
  at version 3 after `trimspace`. The earlier 500 was the old task still holding
  the newline-carrying key in its environment — env vars can't be fixed in
  place, only replaced, which is exactly what the version pin forces.
- Target group `idfocre08938d5a86b57586e0253619f` on 8080, target healthy,
  `GET /ping` -> 200.
- `GET /IDfinder` returns 200 with `{"success": true, "items": []}`.

**Not verified:** the `PUBLIC_FIELDS` redaction. The table is empty, so the
check for leaked `id_number_hint` / `reporter_*` fields was vacuous. Confirmed
by code inspection only — worth re-checking once real records exist.

**Still outstanding:** rotate the Groq API key (leaked into CloudWatch, see
above), and the deferred design items listed earlier.
