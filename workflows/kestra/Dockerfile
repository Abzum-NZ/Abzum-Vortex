FROM kestra/kestra:v1.0.57@sha256:bc6704c896afbd846602cd5655c3569fe5953a8c91ccc84d64012545fc204101

USER root

ARG TARGETARCH
ARG SUPABASE_CLI_VERSION=2.116.0
ARG DOPPLER_CLI_VERSION=3.76.5

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git jq openssl postgresql-client; \
    case "${TARGETARCH}" in \
      amd64) \
        supabase_sha="5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158"; \
        doppler_sha="1b2f412d984920d665daf233ab6c15b364df9339b5c5b5224d5e8ee4e0a70154" \
        ;; \
      arm64) \
        supabase_sha="015a45756bb8459716a4b44b020605adc11956cd7d0bd5824aec2ed1c8287933"; \
        doppler_sha="567f051c4c334b79a37ee44c9373671c451dd8a4945ed49288a8f3fd0b73ec89" \
        ;; \
      *) echo "Unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" \
      --output /tmp/supabase.tar.gz; \
    echo "${supabase_sha}  /tmp/supabase.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file /tmp/supabase.tar.gz --directory /usr/local/bin supabase; \
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
      "https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_CLI_VERSION}/doppler_${DOPPLER_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" \
      --output /tmp/doppler.tar.gz; \
    echo "${doppler_sha}  /tmp/doppler.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file /tmp/doppler.tar.gz --directory /usr/local/bin doppler; \
    chmod 0755 /usr/local/bin/supabase /usr/local/bin/doppler; \
    rm -f /tmp/supabase.tar.gz /tmp/doppler.tar.gz; \
    rm -rf /var/lib/apt/lists/*; \
    supabase --version; \
    doppler --version; \
    git --version; \
    psql --version

# Coolify builds from an ephemeral checkout, so runtime bind mounts to relative
# source paths become empty after deployment. Keep the reviewed operational
# definitions in the immutable image that was built from the reviewed commit.
COPY --chmod=0444 flows/ /app/vortex-flows/
COPY --chmod=0555 scripts/ /app/vortex-operations/
