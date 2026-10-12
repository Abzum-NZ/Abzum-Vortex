FROM kestra/kestra:v1.0.57@sha256:bc6704c896afbd846602cd5655c3569fe5953a8c91ccc84d64012545fc204101

USER root

# Coolify builds from an ephemeral checkout, so runtime bind mounts to relative
# source paths become empty after deployment. Keep the reviewed operational
# definitions in the immutable image that was built from the reviewed commit.
COPY --chmod=0444 flows/ /app/vortex-flows/
