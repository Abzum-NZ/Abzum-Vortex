FROM gradle:8.14.3-jdk21@sha256:21bd311ed01360c189b8870c6b6e988199ff10f72d445d02fb39d3cff9da91d7 AS plugin-build

WORKDIR /plugin
COPY workflows/kestra/application/plugin/build.gradle ./build.gradle
COPY workflows/kestra/application/plugin/gradle.properties ./gradle.properties
COPY workflows/kestra/application/plugin/settings.gradle ./settings.gradle
COPY workflows/kestra/application/plugin/src ./src
RUN gradle --no-daemon --no-build-cache shadowJar

FROM kestra/kestra:v1.0.57@sha256:bc6704c896afbd846602cd5655c3569fe5953a8c91ccc84d64012545fc204101

COPY --from=plugin-build --chmod=0444 /plugin/build/libs/vortex-protected-callback-1.0.0.jar /app/plugins/vortex-protected-callback-1.0.0.jar
