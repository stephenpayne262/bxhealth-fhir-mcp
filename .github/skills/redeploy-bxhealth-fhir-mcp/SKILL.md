---
name: redeploy-bxhealth-fhir-mcp
description: 'Redeploy BXHEALTH-FHIR-MCP to AWS Kubernetes: explain the plan, obtain confirmation, commit current changes locally, test in Docker, publish to GHCR, and delete/recreate only this app deployment, service, and ingress while preserving DNS, TLS, Secrets, and other apps. Use when explicitly asked to redeploy this application.'
argument-hint: 'Optional local commit message'
user-invocable: true
disable-model-invocation: true
---

# Redeploy BXHEALTH-FHIR-MCP

## Scope and mandatory approval

This is a destructive, downtime-producing workflow. Invoking this skill is
not confirmation to execute it. Start with read-only inspection, describe the
specific plan, then request explicit approval using the available question
tool. If there is no question tool, explain the plan and wait for an explicit
reply. Cancellation, an ambiguous response, or no response means stop.

Creating or editing this skill does not authorize running it.

Fixed deployment identity:

- Repository: `stephenpayne262/bxhealth-fhir-mcp`.
- Application display name: **BXHEALTH-FHIR-MCP**.
- Expected kubectl context: `ping-dev-aws-us-east-2-oidc`.
- Namespace: `ping-devops-stephenpayne`.
- Deployment, Service, and Ingress: `bxhealth-fhir-mcp`.
- Deployment container: `mcp`.
- Registry: `ghcr.io/stephenpayne262/bxhealth-fhir-mcp`.
- Public origin: `https://bxhealth-fhir-mcp.ping-devops.com`.
- Application Secret: `bxhealth-fhir-mcp-secrets`.
- TLS: ingress controller default `*.ping-devops.com` certificate; the app
  Ingress intentionally has no `secretName`. If a named Secret is configured
  later, verify its existence without retrieving its contents.

A context, namespace, hostname, resource-name, or registry discrepancy requires
clarification before proceeding. Do not silently retarget the workflow.
Use `--context ping-dev-aws-us-east-2-oidc` and
`--namespace ping-devops-stephenpayne` on every namespaced kubectl operation.
Do not change the user's global kubectl context.

Never delete the namespace, Secrets, certificates, DNS records, AWS load
balancers, ingress controller, registry package, or unrelated applications.
The public website and MCP endpoint are served by this same app/Ingress;
there is no separately authorized S3, CloudFront, Route 53, or other AWS
website teardown. Stop if a separate website is discovered.

## 1. Read-only preflight and plan

Read the current versions of:

- `infra/k8s/k8s.yaml`, `infra/k8s/ingress.yml`, and `infra/k8s/README.md`.
- `infra/Dockerfile`, `.dockerignore`, and `.github/workflows/deploy-main.yml`.

Inspect git status, staged/unstaged diffs, and untracked filenames. Identify
exactly which files would be committed. Include previously staged files in
this review; never assume they are approved. Exclude credentials, environment
files, generated files, and unrelated work. Do not display secret file values.
Check for conflicts, detached HEAD, and unexpected remotes. Ask how to handle
unrelated changes instead of committing them silently.

Check Docker availability and buildx support without starting services or
changing credentials. Check cluster connectivity, the expected context,
permissions, and the live app's image and rollout state. Check required
Secrets by metadata only; never retrieve their data. Check IngressClass
`nginx-public`, public DNS, and TLS using normal certificate verification.
Check for any active deploy workflow or rollout that might race this operation.
If concurrent deployment cannot be ruled out, stop for coordination.

Do not run builds, stage files, commit, log in, push, apply, delete, or restart
anything during this preflight. Do not inspect credential stores or print
access tokens. If access is missing, ask the user to authenticate themselves.

Present a plan containing:

1. Current branch and explicit files to commit, plus proposed commit message.
2. Local commit only: **no git push, merge, or GitHub Actions dispatch**.
3. Docker check stage and ARM64 image publication using a unique commit tag.
4. Exact context, namespace, public URL, and the three resources to replace.
5. Expected downtime and loss of all in-memory MCP sessions.
6. Preservation of DNS, TLS, Secrets, other apps, and the shared load balancer.
7. Validation steps, blockers, and the proposed rollback approach.

Ask for explicit confirmation of this plan. A material scope change after
approval requires another confirmation. If DNS/TLS or other prerequisites
are missing, resolve them before deletion; do not assume approval to deploy
a broken public site.

## 2. Commit locally and validate before downtime

After approval, stage only the reviewed files with explicit paths; do not use
`git add .` or `git add -A`. Inspect the staged diff and run `git diff --check`.
Commit using the approved message with this trailer:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

If there are no changes, report that no new commit is needed and use current
HEAD. Never amend, reset, force-push, or push the branch. Record full HEAD and
ensure no uncommitted build-affecting changes remain. If hooks modify files,
stop and review them before proceeding.

Run project code only in Docker Desktop:

```bash
docker build -f infra/Dockerfile --target check --progress=plain .
```

A failed typecheck/test/build stops the workflow before deletion. Do not
commit unapproved fixes automatically. Explain failures and get approval for
any additional changes needed. Do not touch the currently running local
Compose service merely to publish a cluster image.

## 3. Publish and verify the replacement image

Use the full committed SHA as the tag. Build `linux/arm64`, target `runtime`,
and push to the fixed GHCR registry. Publish only the commit tag; do not move
`latest` or another existing tag implicitly. If that tag already exists,
verify it represents this commit; use an approved unique tag if uncertain.

```bash
TAG=$(git rev-parse HEAD)
docker buildx build --platform linux/arm64 --target runtime \
  -f infra/Dockerfile \
  -t "ghcr.io/stephenpayne262/bxhealth-fhir-mcp:$TAG" --push .
docker buildx imagetools inspect "ghcr.io/stephenpayne262/bxhealth-fhir-mcp:$TAG"
```

Record and verify the registry digest and ARM64 platform. Verify anonymous
registry access because the deployment has no imagePullSecret. Keep any
short-lived public registry token private. If permission or visibility fails,
stop without taking the live app down; never request a PAT in chat.
Deploy the verified immutable digest, not `latest`.

## 4. Prepare recovery, then replace only this application

Before deletion, save the previous Deployment, Service, and Ingress specs,
image digest, and replica count in a private temporary directory outside the
repository, with restrictive permissions. Do not snapshot Secret contents.
Ensure saved manifests can be reapplied: remove server-generated identity,
status, resource versions, managed fields, and stale allocation fields such
as Service cluster IPs. Do not delete live objects until recovery manifests
are prepared and their resource names/namespaces are checked.

Render a temporary copy of `infra/k8s/k8s.yaml`, replacing exactly the app
container image with the verified digest. Confirm exactly one intended image
was replaced, Deployment replicas remain 1 with Recreate, and the Service
port matches the Ingress backend. Validate rendered manifests and Ingress
with server-side dry-run before deletion. Do not change tracked manifests
just to insert the release digest.

Recheck the live image/rollout for changes since preflight. If another actor
changed it, stop and ask rather than overwriting their deployment.

Delete only the named objects, explicitly scoped to the approved context
and namespace: Ingress `bxhealth-fhir-mcp`, Deployment `bxhealth-fhir-mcp`,
and Service `bxhealth-fhir-mcp`. Wait for the old app pods to terminate before
recreating. Never use `delete all`, namespace deletion, broad selectors,
forced deletion, or apply/delete of the entire `infra/k8s/` directory.

Apply the rendered Deployment/Service, wait for rollout with a bounded timeout
(e.g. 180 seconds), then apply the app Ingress. Preserve existing application
and TLS Secrets. Updating configuration/Secrets is outside this skill's
default scope and requires separate explicit approval.

## 5. Verify and report

Verify the deployed image digest, one ready pod, restart count, Service
endpoints, and Ingress routing. Then test public HTTPS without `-k`:

- `/healthz`: HTTP 200.
- `/readyz`: HTTP 200, OAuth ready, FHIR R4 version match.
- `/.well-known/oauth-protected-resource/mcp` and its root form: HTTP 200,
  correct resource and issuer.
- `/cimd/claude-code.json`, `/cimd/gemini-cli.json`,
  `/cimd/mcp-inspector.json`, `/cimd/vscode.json`: HTTP 200, no redirects,
  JSON at most 5 KB, `client_id` exactly equal to each public document URL.
- Unauthenticated POST `/mcp`: HTTP 401 and `WWW-Authenticate` metadata.

If public checks fail, use a temporary port-forward or in-pod check to
separate app health from routing/TLS issues. Stop temporary helpers after
use. Do not claim authenticated end-to-end success without a real client
login; ask the user to reconnect and authenticate, since old sessions are lost.

On any failure, stop subsequent destructive steps and report the exact stage
and current live state. Collect only bounded, relevant diagnostics; avoid
logging tokens or patient data. Do not repeatedly delete/recreate in a loop.
Offer restoration of the previous saved resource specs and image. Request
confirmation before rollback unless that exact recovery action was explicitly
approved in the original plan. A deleted Deployment has no rollout history,
so `kubectl rollout undo` is not the recovery mechanism here.

On success, remove only named temporary files/directories and report the
local commit SHA, published tag/digest, cluster context/namespace, rollout and
public-check results, and that git was not pushed. On failure, retain private
recovery files and give their location for recovery; never register them as
public artifacts or commit them.
