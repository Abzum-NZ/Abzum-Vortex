package io.kestra.plugin.vortex;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.kestra.core.models.annotations.Plugin;
import io.kestra.core.models.property.Property;
import io.kestra.core.models.tasks.RunnableTask;
import io.kestra.core.models.tasks.Task;
import io.kestra.core.runners.RunContext;
import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Builder;
import lombok.EqualsAndHashCode;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.ToString;
import lombok.experimental.SuperBuilder;
import org.erdtman.jcs.JsonCanonicalizer;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** Sends one signed, typed Vortex protected-operation request for a Kestra task attempt. */
@SuperBuilder
@ToString(onlyExplicitlyIncluded = true)
@EqualsAndHashCode
@Getter
@NoArgsConstructor
@Schema(
    title = "Vortex protected callback",
    description = "Calls the fixed Vortex endpoint with a signed protected-operation envelope."
)
@Plugin
public class ProtectedCallback extends Task implements RunnableTask<ProtectedCallback.Output> {
    private static final String CALLBACK_URL_ENVIRONMENT_KEY = "VORTEX_PROTECTED_CALLBACK_URL";
    private static final int MAXIMUM_BODY_LENGTH = 131_072;
    private static final Duration CALLBACK_LIFETIME = Duration.ofMinutes(5);
    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final Set<String> STATIC_BINDING_FIELDS = Set.of(
        "contractVersion",
        "organizationId",
        "applicationRootId",
        "workflowRevision",
        "nodeId",
        "operationKey",
        "inputs"
    );
    private static final Set<String> INPUT_CONTRACT_FIELDS = Set.of(
        "properties",
        "runtimeScope",
        "allow_refusal"
    );
    private static final Pattern RESOLVED_INPUT_REFERENCE = Pattern.compile(
        "\\{\\{ (?:outputs\\.e_[a-z0-9_]+\\.value|currentEachOutput\\(outputs\\.e_[a-z0-9_]+\\)\\.value) \\}\\}"
    );

    @Schema(description = "The compiler-generated protected-operation binding, raw-wrapped as JSON.")
    private Property<String> envelope;

    @Schema(description = "The fixed Vortex callback signing key resolved by Kestra.")
    private Property<String> callbackKey;

    @Schema(description = "The Vortex run UUID supplied by the trusted start dispatcher as an execution label.")
    private Property<String> runId;

    @Schema(description = "The current Kestra task attempt, starting at one.")
    private Property<Integer> attempt;

    @Schema(description = "The stable Kestra task-run ID used as the callback duplicate-protection key.")
    private Property<String> duplicateProtectionKey;

    // Keep generated references raw until renderTyped preserves their JSON value types.
    @Schema(description = "Resolved operation inputs produced by the Vortex evaluator.")
    private Object resolvedInputs;

    @Schema(description = "The resolved typed evaluator scope for this protected callback.")
    private Object runtimeScope;

    @Override
    public Output run(RunContext runContext) throws Exception {
        try {
            return sendCallback(runContext);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw refused();
        } catch (Exception error) {
            throw refused();
        }
    }

    private Output sendCallback(RunContext runContext) throws Exception {
        String rawEnvelope = renderRequired(runContext, envelope, String.class);
        String signingKey = renderRequired(runContext, callbackKey, String.class);
        String vortexRunId = requireUuid(renderRequired(runContext, runId, String.class));
        Integer currentAttempt = renderRequired(runContext, attempt, Integer.class);
        String duplicateKey = renderRequired(runContext, duplicateProtectionKey, String.class);
        if (currentAttempt < 1 || duplicateKey.length() < 16 || duplicateKey.length() > 200) {
            throw refused();
        }

        ObjectNode request = parseStaticBinding(rawEnvelope);
        mergeResolvedInputs(runContext, request);
        mergeRuntimeScope(runContext, request);
        request.put("runId", vortexRunId);
        request.put("attempt", currentAttempt);
        Instant issuedAt = Instant.now();
        request.put("issuedAt", issuedAt.toString());
        request.put("expiresAt", issuedAt.plus(CALLBACK_LIFETIME).toString());
        request.put("duplicateProtectionKey", duplicateKey);
        request.put("signedCallerProof", sign(request, signingKey));

        byte[] requestBody = OBJECT_MAPPER.writeValueAsBytes(request);
        if (requestBody.length > MAXIMUM_BODY_LENGTH) {
            throw refused();
        }

        HttpRequest httpRequest = HttpRequest.newBuilder(callbackUri())
            .timeout(Duration.ofSeconds(30))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofByteArray(requestBody))
            .build();
        HttpResponse<InputStream> response = HTTP_CLIENT.send(httpRequest, HttpResponse.BodyHandlers.ofInputStream());
        byte[] responseBody;
        try (InputStream body = response.body()) {
            responseBody = body.readNBytes(MAXIMUM_BODY_LENGTH + 1);
        }
        if (response.statusCode() != 200 || responseBody.length > MAXIMUM_BODY_LENGTH) {
            throw refused();
        }
        return successfulOutput(OBJECT_MAPPER.readTree(responseBody), request);
    }

    private static ObjectNode parseStaticBinding(String rawEnvelope) throws Exception {
        JsonNode parsed = OBJECT_MAPPER.readTree(rawEnvelope);
        if (!(parsed instanceof ObjectNode binding) || !hasExactly(binding, STATIC_BINDING_FIELDS)) {
            throw refused();
        }
        JsonNode inputs = binding.get("inputs");
        if (!(inputs instanceof ObjectNode inputContract) || !allowedInputContract(inputContract)) {
            throw refused();
        }
        JsonNode properties = inputContract.get("properties");
        if (!(properties instanceof ObjectNode)) {
            throw refused();
        }
        return binding;
    }

    private void mergeResolvedInputs(RunContext runContext, ObjectNode request) throws Exception {
        ObjectNode inputContract = (ObjectNode) request.get("inputs");
        ObjectNode properties = (ObjectNode) inputContract.get("properties");
        if (resolvedInputs == null) {
            return;
        }
        if (properties.has("inputs") || !properties.path("operation").isTextual()) {
            throw refused();
        }
        Object resolved;
        if (resolvedInputs instanceof String reference && RESOLVED_INPUT_REFERENCE.matcher(reference).matches()) {
            resolved = runContext.renderTyped(reference);
        } else if (resolvedInputs instanceof Map<?, ?> empty && empty.isEmpty()) {
            resolved = empty;
        } else {
            throw refused();
        }
        JsonNode resolvedNode = resolved == null ? null : OBJECT_MAPPER.valueToTree(resolved);
        if (!(resolvedNode instanceof ObjectNode)) {
            throw refused();
        }
        properties.set("inputs", resolvedNode);
    }

    private void mergeRuntimeScope(RunContext runContext, ObjectNode request) throws Exception {
        if (runtimeScope == null) {
            return;
        }
        JsonNode scopeNode = OBJECT_MAPPER.valueToTree(runtimeScope);
        if (!(scopeNode instanceof ObjectNode)) {
            throw refused();
        }
        renderRuntimeScope(runContext, (ObjectNode) scopeNode);
        ObjectNode inputContract = (ObjectNode) request.get("inputs");
        if (inputContract.has("runtimeScope")) {
            throw refused();
        }
        inputContract.set("runtimeScope", scopeNode);
    }

    private static void renderRuntimeScope(RunContext runContext, ObjectNode scope) throws Exception {
        JsonNode inputs = scope.get("inputs");
        JsonNode outputs = scope.get("outputs");
        if (!(inputs instanceof ObjectNode inputValues) || !(outputs instanceof ObjectNode taskOutputs)
            || !(scope.get("variables") instanceof ObjectNode)) {
            throw refused();
        }
        Iterator<Map.Entry<String, JsonNode>> inputEntries = inputValues.fields();
        while (inputEntries.hasNext()) {
            Map.Entry<String, JsonNode> entry = inputEntries.next();
            renderScopeValue(runContext, entry.getValue(), "{{ inputs." + entry.getKey() + " }}", null);
        }
        Iterator<Map.Entry<String, JsonNode>> tasks = taskOutputs.fields();
        while (tasks.hasNext()) {
            Map.Entry<String, JsonNode> task = tasks.next();
            if (!(task.getValue() instanceof ObjectNode values)) {
                throw refused();
            }
            Iterator<Map.Entry<String, JsonNode>> entries = values.fields();
            while (entries.hasNext()) {
                Map.Entry<String, JsonNode> entry = entries.next();
                String output = "outputs.t_" + task.getKey() + "." + entry.getKey();
                String loopOutput = "currentEachOutput(outputs.t_" + task.getKey() + ")." + entry.getKey();
                renderScopeValue(runContext, entry.getValue(), "{{ " + output + " }}", "{{ " + loopOutput + " }}");
            }
        }
    }

    private static void renderScopeValue(
        RunContext runContext,
        JsonNode candidate,
        String reference,
        String loopReference
    ) throws Exception {
        if (!(candidate instanceof ObjectNode value) || !value.path("value").isTextual()) {
            throw refused();
        }
        String token = value.path("value").textValue();
        if (!reference.equals(token) && !token.equals(loopReference)) {
            throw refused();
        }
        value.set("value", OBJECT_MAPPER.valueToTree(runContext.renderTyped(token)));
    }

    private static boolean allowedInputContract(ObjectNode inputContract) {
        Iterator<String> fieldNames = inputContract.fieldNames();
        while (fieldNames.hasNext()) {
            if (!INPUT_CONTRACT_FIELDS.contains(fieldNames.next())) {
                return false;
            }
        }
        JsonNode refusal = inputContract.get("allow_refusal");
        return refusal == null || refusal.isBoolean();
    }

    private static boolean hasExactly(ObjectNode value, Set<String> names) {
        if (value.size() != names.size()) {
            return false;
        }
        Iterator<String> fieldNames = value.fieldNames();
        while (fieldNames.hasNext()) {
            if (!names.contains(fieldNames.next())) {
                return false;
            }
        }
        return true;
    }

    private static Output successfulOutput(JsonNode response, ObjectNode request) throws Exception {
        if (!response.isObject() || !response.path("outcome").isTextual()) {
            throw refused();
        }
        String outcome = response.path("outcome").textValue();
        if (!"completed".equals(outcome) && !"already_completed".equals(outcome)) {
            throw refused();
        }
        JsonNode outputs = response.get("outputs");
        if (outputs == null || !outputs.isObject()) {
            throw refused();
        }
        boolean hasValue = outputs.has("value");
        boolean hasResult = outputs.has("result");
        if (hasValue == hasResult) {
            throw refused();
        }
        JsonNode maximumItems = request.path("inputs").path("properties").get("maximum_items");
        if (maximumItems != null) {
            JsonNode value = outputs.get("value");
            if (!maximumItems.canConvertToInt() || maximumItems.intValue() < 1
                || value == null || !value.isArray() || value.size() > maximumItems.intValue()) {
                throw refused();
            }
        }
        Object value = hasValue ? OBJECT_MAPPER.convertValue(outputs.get("value"), Object.class) : null;
        Object result = hasResult ? OBJECT_MAPPER.convertValue(outputs.get("result"), Object.class) : null;
        return Output.builder().value(value).result(result).build();
    }

    private static String sign(ObjectNode request, String signingKey) throws Exception {
        byte[] key = signingKey.getBytes(StandardCharsets.UTF_8);
        if (key.length < 32) {
            throw refused();
        }
        ObjectNode unsigned = request.deepCopy();
        unsigned.remove("signedCallerProof");
        String payload = new JsonCanonicalizer(OBJECT_MAPPER.writeValueAsString(unsigned)).getEncodedString();
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
            mac.doFinal(payload.getBytes(StandardCharsets.UTF_8))
        );
    }

    private static URI callbackUri() {
        String configured = System.getenv(CALLBACK_URL_ENVIRONMENT_KEY);
        if (configured == null || configured.isBlank()) {
            throw refused();
        }
        URI uri;
        try {
            uri = URI.create(configured);
        } catch (IllegalArgumentException error) {
            throw refused();
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        boolean https = "https".equalsIgnoreCase(scheme);
        boolean localHttp = "http".equalsIgnoreCase(scheme) && isLoopbackName(host);
        if ((!https && !localHttp) || host == null || uri.getUserInfo() != null || uri.getQuery() != null
            || uri.getFragment() != null || !"/api/flows/callback".equals(uri.getPath())) {
            throw refused();
        }
        return uri;
    }

    private static boolean isLoopbackName(String host) {
        if (host == null) {
            return false;
        }
        String normalized = host.toLowerCase(Locale.ROOT);
        return "localhost".equals(normalized) || "127.0.0.1".equals(normalized)
            || "::1".equals(normalized) || "[::1]".equals(normalized);
    }

    private static String requireUuid(String value) {
        try {
            UUID parsed = UUID.fromString(value);
            if (parsed.equals(new UUID(0L, 0L)) || !parsed.toString().equalsIgnoreCase(value)) {
                throw refused();
            }
            return parsed.toString();
        } catch (IllegalArgumentException error) {
            throw refused();
        }
    }

    private static <T> T renderRequired(RunContext runContext, Property<T> property, Class<T> type) {
        if (property == null) {
            throw refused();
        }
        // A task definition can be reused; runtime identity must be rendered on every attempt.
        return runContext.render(property.skipCache()).as(type).orElseThrow(ProtectedCallback::refused);
    }

    private static IllegalStateException refused() {
        return new IllegalStateException("Vortex protected callback was refused");
    }

    @Builder
    @Getter
    @EqualsAndHashCode
    public static class Output implements io.kestra.core.models.tasks.Output {
        @Schema(description = "The value returned by a protected evaluator callback.")
        private final Object value;

        @Schema(description = "The result returned by a protected operation callback.")
        private final Object result;
    }
}
