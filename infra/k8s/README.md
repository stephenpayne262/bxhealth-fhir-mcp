# Deploying bxhealth-fhir-mcp

Target: Ping SE DevOps cluster `ping-dev-aws-us-east-2`, namespace
`ping-devops-stephenpayne`. After deployment, the service is exposed at
`https://bxhealth-fhir-mcp.ping-devops.com` by
[`ingress.yml`](./ingress.yml). The Ingress routes to the Kubernetes Service
on port 80; the Service forwards to the app on port 3000.

## Cluster facts worth knowing

- **All nodes are arm64** (Graviton `r7g.xlarge`), verified 2026-09-10.
  CI builds `linux/arm64` for that reason. An amd64 image fails as
  `exec format error` in CrashLoopBackOff, which reads like an app bug.
  Note this contradicts `bxhealth-demo-base/docs/setup-cluster.md`,
  which says the build needs an amd64 host; that doc is wrong.
- Default StorageClass is `gp2`. This service is stateless and claims no
  volume.
- The human kubeconfig authenticates through an **interactive OIDC exec
  plugin**, so it cannot be handed to CI (see below).

## One-time setup

### 1. CI deploy identity

`KUBE_CONFIG_B64` cannot be your own kubeconfig: the exec plugin needs a
browser. CI gets a namespace-scoped ServiceAccount instead.

```bash
kubectl apply -n ping-devops-stephenpayne -f infra/k8s/ci-rbac.yaml
```

First confirm this namespace-scoped, long-lived credential is permitted by
cluster policy and that GitHub-hosted runners can reach the Kubernetes API.
If the API is private, use an approved self-hosted runner or networking setup.

Then build the kubeconfig from the issued token. Run these steps in one shell;
the temporary file is created outside the repository:

```bash
umask 077
NS=ping-devops-stephenpayne
CI_DIR=$(mktemp -d)
CI_CONFIG="$CI_DIR/config"
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl get secret github-deployer-token -n $NS -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl get secret github-deployer-token -n $NS -o jsonpath='{.data.token}' | base64 -d)

if [ -z "$SERVER" ] || [ -z "$CA" ] || [ -z "$TOKEN" ]; then
  echo "Missing Kubernetes server, CA, or token; stop and resolve before proceeding." >&2
else
cat > "$CI_CONFIG" <<CFG
apiVersion: v1
kind: Config
clusters:
- name: ping-dev-aws-us-east-2
  cluster: { server: ${SERVER}, certificate-authority-data: ${CA} }
contexts:
- name: ci
  context: { cluster: ping-dev-aws-us-east-2, namespace: ${NS}, user: github-deployer }
current-context: ci
users:
- name: github-deployer
  user: { token: ${TOKEN} }
CFG

fi
unset TOKEN CA
```

Verify it before trusting CI with it:

```bash
KUBECONFIG="$CI_CONFIG" kubectl auth whoami
KUBECONFIG="$CI_CONFIG" kubectl auth can-i patch deployments.apps -n $NS   # yes
KUBECONFIG="$CI_CONFIG" kubectl auth can-i get secrets -n $NS              # no
```

After the expected permissions are verified, upload the credentials and remove
the temporary file. Never commit or print the kubeconfig; base64 is not encryption.
Rotate or revoke this credential according to cluster policy.

```bash
base64 < "$CI_CONFIG" | tr -d '\n' | gh secret set KUBE_CONFIG_B64 \
  --repo stephenpayne262/bxhealth-fhir-mcp
gh secret set K8S_NAMESPACE --body "$NS" --repo stephenpayne262/bxhealth-fhir-mcp
rm "$CI_CONFIG"
rmdir "$CI_DIR"
unset CI_CONFIG CI_DIR SERVER NS
```

### 2. Cluster configuration and application secret

Keep your local `.env` unchanged. Create a separate, gitignored cluster file:

```bash
cp infra/k8s/cluster.env.example infra/k8s/.env.k8s
```

Fill in the issuer and FHIR values in `infra/k8s/.env.k8s`. FHIR and token endpoints
must be reachable from the cluster; `localhost` and `host.docker.internal`
do not point at your Mac from a pod. Do not commit this file.

```bash
kubectl create secret generic bxhealth-fhir-mcp-secrets -n ping-devops-stephenpayne \
  --from-env-file=infra/k8s/.env.k8s
```

Carries the cluster configuration: the `FHIR_*` settings (including
`FHIR_CLIENT_SECRET`), `MCP_PUBLIC_URL` and the `OAUTH_*` settings, among
them `OAUTH_CLIENT_MODE` and its client list or patterns. Only the secret
needs to be here, but keeping all of it in one place means one place to
change it. The CI ServiceAccount deliberately cannot read this secret.

To update an existing Secret without printing its contents:

```bash
kubectl create secret generic bxhealth-fhir-mcp-secrets -n ping-devops-stephenpayne \
  --from-env-file=infra/k8s/.env.k8s --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart -n ping-devops-stephenpayne deployment/bxhealth-fhir-mcp
```

The Deployment pins HTTP transport, the public MCP URL, read-only access,
patient scoping, CIMD client mode, and the accepted client URL patterns.
Its patterns accept documents hosted at
`https://bxhealth-fhir-mcp.ping-devops.com/cimd/*` and ChatGPT documents at
`https://chatgpt.com/oauth/*`, without requiring a manual Secret or admin edit.
Explicit Deployment environment entries take precedence over `envFrom` values.
Saved admin overrides still take precedence over the environment and survive
redeployments on the PVC; keep any saved pattern list aligned with the manifest.

### 3. Container image

CI pushes `ghcr.io/stephenpayne262/bxhealth-fhir-mcp` using the workflow's
own `GITHUB_TOKEN`; no registry secret is needed.

**The package must be public**, because the manifest carries no
`imagePullSecret`. Newly published container packages default to private;
repository visibility does not make the container package public. After the
first image publication, change the package visibility before deploying:

> Package settings → Danger Zone → Change visibility → Public

To keep it private instead, create a `docker-registry` secret from a PAT
with `read:packages` and add `imagePullSecrets` back to the pod spec.

To build and publish without GitHub Actions, use Docker Desktop from the
repository root. Authenticate with an approved GHCR credential with
`write:packages` permission; a GitHub CLI login alone does not guarantee that
permission. Do not put the token in a command argument, tracked file, or image.

```bash
# Paste the registry token at Docker's password prompt, not your GitHub password.
docker login ghcr.io --username stephenpayne262
TAG=$(git rev-parse --short=7 HEAD)
IMAGE=ghcr.io/stephenpayne262/bxhealth-fhir-mcp
# Ensure the worktree is clean before publishing a commit-tagged image.
git status --short
docker build -f infra/Dockerfile --target check .
docker buildx build --platform linux/arm64 --target runtime \
  -f infra/Dockerfile -t "$IMAGE:$TAG" -t "$IMAGE:latest" --push .
```

These commands publish an image only; they do not apply Kubernetes manifests.
The `latest` tag supports the manual manifest below; CI deploys a commit tag.
Public images expose application code and bundled files, so never bake secrets
into the image. The build context excludes environment files and `infra/`.

### 4. DNS, TLS, and CIMD cutover

Before exposing the app, confirm with the cluster administrator:

- `nginx-public` is the correct IngressClass.
- `bxhealth-fhir-mcp.ping-devops.com` resolves to the public ingress controller.
- The ingress controller serves its existing valid `*.ping-devops.com`
  default certificate. The Ingress intentionally omits `secretName`; no
  app-specific TLS Secret is required. This manifest does not provision
  certificates or DNS.
- The namespace exists, and GitHub's deploy identity targets this namespace.

The app publicly serves these documents without OAuth or redirects:

- `https://bxhealth-fhir-mcp.ping-devops.com/cimd/claude-code.json`
- `https://bxhealth-fhir-mcp.ping-devops.com/cimd/gemini-cli.json`
- `https://bxhealth-fhir-mcp.ping-devops.com/cimd/mcp-inspector.json`
- `https://bxhealth-fhir-mcp.ping-devops.com/cimd/vscode.json`

Each response uses `MCP_PUBLIC_URL` to generate its exact `client_id`, not
request headers. AIC must be able to fetch the public HTTPS URLs. Set the
AIC CIMD profile's URL patterns to match these URLs (exactly one profile per
URL), with token endpoint authentication method `none`. Configure the token
modification script's resource/audience mapping for
`https://bxhealth-fhir-mcp.ping-devops.com/mcp`. Update each MCP client's
server URL and client ID, then sign in again; cached local tokens have the
old audience/client identity. Local callback URLs stay local. Verify VS
Code's actual callback against the document: its portless loopback entry
has not been verified against AIC's redirect matching. AIC's CORS and CSP
configuration must also allow the client flows; see
[the AIC setup guide](../../docs/aic-setup.md).

For ChatGPT, AIC must also allow `https://chatgpt.com/oauth/*` in exactly one
CIMD profile. On that profile's Core tab, allow `openid`, `email`, and
`fhir-mcp:read`, and configure the exact ChatGPT callback URI. The MCP server
allowlist alone does not configure AIC. ChatGPT hosts its own client document;
do not add one in the MCP admin console. See
[ChatGPT setup](../../cimd/README.md#chatgpt).

### 5. GitHub Actions configuration

Set repository secrets `KUBE_CONFIG_B64` and
`K8S_NAMESPACE=ping-devops-stephenpayne`. The workflow verifies the namespace
before applying either manifest. The CI Role already permits Ingress updates.
The public GHCR package must be pullable before the first successful rollout.

## Deploy

Push to `main`; the workflow runs `check` → `build-and-push` → `deploy`.
On forks, enable workflows on the repository's Actions page first. Manual
workflow dispatch also requires the workflow to be registered on the default
branch; a branch-only workflow may return HTTP 404.

Manual workflow runs default to build-and-publish only. Enable the `deploy`
input explicitly to deploy a manual run. To publish a branch without deploying:

```bash
gh workflow run deploy-main.yml --ref PayneUpdate-cimd -f deploy=false
```

Manually, after publishing the image, creating the application Secret, and verifying the controller certificate:

```bash
kubectl apply -n ping-devops-stephenpayne -f infra/k8s/k8s.yaml
kubectl apply -f infra/k8s/ingress.yml
kubectl rollout status -n ping-devops-stephenpayne deploy/bxhealth-fhir-mcp
```

## Verify

Version 1.1.0 adds a public landing page at
`https://bxhealth-fhir-mcp.ping-devops.com/` with a health dashboard and
setup instructions for all four clients. `/mcp` remains the authenticated
protocol endpoint. The dashboard calls public URLs from the pod, so allow
outbound/hairpin access to the public host. Its results use a 30-second cache
and five-second per-request budget, not the Kubernetes probe policy.


Verify the Ingress hostname and the controller-provided TLS certificate
after applying the manifest.
Check the public endpoints without disabling certificate verification:

```bash
curl --fail-with-body https://bxhealth-fhir-mcp.ping-devops.com/healthz
curl --fail-with-body https://bxhealth-fhir-mcp.ping-devops.com/readyz
curl -i -X POST -H 'Content-Type: application/json' -d '{}' \
  https://bxhealth-fhir-mcp.ping-devops.com/mcp   # must return 401
for client in claude-code gemini-cli mcp-inspector vscode; do
  url="https://bxhealth-fhir-mcp.ping-devops.com/cimd/$client.json"
  curl --fail --silent --show-error "$url" | jq -e --arg url "$url" '.client_id == $url'
done
```

Then authenticate with an MCP client, list tools, and verify that a caller
cannot access another patient's records. Recreate rollouts lose in-memory
sessions, so reconnect clients after a deployment. An idle SSE connection
may reconnect after the Ingress's one-hour timeout. Cookie affinity does not
make multiple replicas safe for clients that do not retain cookies.

The service can also be checked through a port-forward:

```bash
kubectl port-forward -n ping-devops-stephenpayne deploy/bxhealth-fhir-mcp 3000:3000

curl -s localhost:3000/healthz
curl -s localhost:3000/readyz    # reports the FHIR server's advertised fhirVersion
npx @modelcontextprotocol/inspector    # point at http://localhost:3000/mcp
```

## Notes

- **One replica, on purpose.** MCP sessions are held in memory keyed by
  `Mcp-Session-Id`. A second pod answers follow-up requests for sessions
  it never saw, producing intermittent `Session not found` 404s. Scaling
  up needs sticky sessions or a shared session store first.
- Both probes use `/healthz`, which never touches FHIR. `/readyz` does
  call FHIR and is the better-looking readiness probe, but wiring it in
  would evict the pod from the Service whenever FHIR hiccups, turning a
  clear tool error into an opaque 503.
- Teardown: `kubectl delete -f infra/k8s/ingress.yml` and
  `kubectl delete -n ping-devops-stephenpayne -f infra/k8s/k8s.yaml`.
  Per SE DevOps policy cleanup is your responsibility;
  `kubectl scale --replicas=0` is the cheap idle state.

## Admin console

Set `MCP_ADMIN` and `MCP_ADMIN_PASSWORD` (12+ characters) in `.env.k8s`, recreate the
Secret, and open `/admin` on the public host. It edits every setting except the admin
login, `MCP_TRANSPORT`, `PORT` and `MCP_DATA_DIR`; validates the whole configuration
before saving; then exits so Kubernetes restarts the container. Secrets are write-only and
never exported. CIMD documents are edited live at `/cimd/NAME.json`, and JSON
export/import covers settings and documents.

Edits are saved to `MCP_DATA_DIR` (`/data`), backed by the `bxhealth-fhir-mcp-data`
PersistentVolumeClaim, so they survive restarts and redeploys. Create the claim once with
your own account (the CI account can't): `kubectl apply -n $NS -f infra/k8s/pvc.yaml`.
Saved edits take precedence over the Secret, so delete the override (or the claim) to go
back to the Secret's values.
