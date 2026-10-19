# Deploying bxhealth-fhir-mcp

Target: Ping SE DevOps cluster `ping-dev-aws-us-east-2`, namespace
`ping-devops-stephenpayne`. The service is exposed at
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

Then build the kubeconfig from the issued token:

```bash
NS=ping-devops-stephenpayne
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl get secret github-deployer-token -n $NS -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl get secret github-deployer-token -n $NS -o jsonpath='{.data.token}' | base64 -d)

cat > ci-kubeconfig.yaml <<CFG
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

base64 < ci-kubeconfig.yaml | tr -d '\n' | gh secret set KUBE_CONFIG_B64
gh secret set K8S_NAMESPACE --body "$NS"
rm ci-kubeconfig.yaml
```

Verify it before trusting CI with it:

```bash
KUBECONFIG=ci-kubeconfig.yaml kubectl auth whoami
KUBECONFIG=ci-kubeconfig.yaml kubectl auth can-i patch deployments.apps -n $NS   # yes
KUBECONFIG=ci-kubeconfig.yaml kubectl auth can-i get secrets -n $NS              # no
```

### 2. Cluster configuration and application secret

Keep your local `.env` unchanged. Create a separate, gitignored cluster file:

```bash
cp infra/k8s/cluster.env.example .env.k8s
```

Fill in the issuer and FHIR values in `.env.k8s`. FHIR and token endpoints
must be reachable from the cluster; `localhost` and `host.docker.internal`
do not point at your Mac from a pod. Do not commit this file.

```bash
kubectl create secret generic bxhealth-fhir-mcp-secrets -n ping-devops-stephenpayne \
  --from-env-file=.env.k8s
```

Carries the cluster configuration: the `FHIR_*` settings (including
`FHIR_CLIENT_SECRET`), `MCP_PUBLIC_URL` and the `OAUTH_*` settings, among
them `OAUTH_CLIENT_MODE` and its client list or patterns. Only the secret
needs to be here, but keeping all of it in one place means one place to
change it. The CI ServiceAccount deliberately cannot read this secret.

To update an existing Secret without printing its contents:

```bash
kubectl create secret generic bxhealth-fhir-mcp-secrets -n ping-devops-stephenpayne \
  --from-env-file=.env.k8s --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart -n ping-devops-stephenpayne deployment/bxhealth-fhir-mcp
```

The Deployment pins HTTP transport, the public MCP URL, read-only access,
and patient scoping so local settings cannot accidentally override them.

### 3. Container image

CI pushes `ghcr.io/stephenpayne262/bxhealth-fhir-mcp` using the workflow's
own `GITHUB_TOKEN`; no registry secret is needed.

**The package must be public**, because the manifest carries no
`imagePullSecret`. GHCR packages inherit the repository's visibility on
first push, so a package from a private repo starts private and the
first deploy fails with `ImagePullBackOff` until it is flipped:

> Package settings → Danger Zone → Change visibility → Public

To keep it private instead, create a `docker-registry` secret from a PAT
with `read:packages` and add `imagePullSecrets` back to the pod spec.

### 4. DNS, TLS, and CIMD cutover

Before exposing the app, confirm with the cluster administrator:

- `nginx-public` is the correct IngressClass.
- `bxhealth-fhir-mcp.ping-devops.com` resolves to the public ingress controller.
- The TLS Secret `bxhealth-fhir-mcp-tls` exists in `ping-devops-stephenpayne`
  and contains a certificate for that exact hostname. This manifest does not
  provision certificates or DNS.
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

### 5. GitHub Actions configuration

Set repository secrets `KUBE_CONFIG_B64` and
`K8S_NAMESPACE=ping-devops-stephenpayne`. The workflow verifies the namespace
before applying either manifest. The CI Role already permits Ingress updates.
The public GHCR package must be pullable before the first successful rollout.

## Deploy

Push to `main`; the workflow runs `check` → `build-and-push` → `deploy`.
Manual workflow runs default to build-and-publish only. Enable the `deploy`
input explicitly to deploy a manual run. To publish a branch without deploying:

```bash
gh workflow run deploy-main.yml --ref PayneUpdate-cimd -f deploy=false
```
Manually:

```bash
kubectl apply -n ping-devops-stephenpayne -f infra/k8s/k8s.yaml
kubectl apply -f infra/k8s/ingress.yml
kubectl rollout status -n ping-devops-stephenpayne deploy/bxhealth-fhir-mcp
```

## Verify

Verify the Ingress hostname and TLS certificate after applying the manifest
(the TLS Secret `bxhealth-fhir-mcp-tls` must already exist in the namespace).
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
