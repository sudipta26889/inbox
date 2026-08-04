# Ollama Model Structured Output Compatibility

## Problem Overview

When integrating Ollama models (specifically `ollama/gpt-oss:120b-cloud`) accessed through LiteLLM proxy into the inbox system, we encountered critical failures with structured output generation for:

1. **Rule creation** (`/api/user/rules/prompt`)
2. **Email sender categorization** (automated email processing)

### Error Symptoms

```
Error: No object generated: response did not match schema.
AI SDK Warning: The feature "responseFormat" is not supported. JSON response format schema is only supported with structuredOutputs
```

The system would retry multiple times and ultimately fail, preventing users from:
- Creating automation rules via AI assistant
- Automatically categorizing email senders
- Processing emails with AI-powered features

## Root Cause Analysis

### 1. Fundamental Incompatibility

**OpenAI vs Ollama Structured Outputs:**

- **OpenAI Models**: Support native structured outputs via the `response_format` parameter with `json_schema` type. The API guarantees the response will match the provided JSON schema.

- **Ollama Models**: Only support JSON mode via `format: "json"` parameter. This ensures valid JSON output but does NOT guarantee schema conformance. The model tries its best to follow the schema based on prompts, but there's no enforcement.

### 2. Vercel AI SDK Assumptions

The Vercel AI SDK's `generateObject()` function has two modes:

1. **With `supportsStructuredOutputs: true`** (default for OpenAI-compatible providers):
   - Sends `response_format` with the full JSON schema
   - Expects the provider to enforce the schema
   - Validates the response matches the schema exactly
   - **Fails immediately if schema doesn't match**

2. **With `supportsStructuredOutputs: false`**:
   - Still tries to use `response_format`
   - Falls back to parsing JSON from text content
   - Uses `jsonrepair` to fix minor issues
   - **Still fails if schema validation doesn't pass**

### 3. Specific Issues Encountered

#### Issue #1: Schema Validation Failures
Even with `supportsStructuredOutputs: false`, the AI SDK's `generateObject()` strictly validates against Zod schemas. Ollama models would:

- Generate valid JSON ✓
- Include most required fields ✓
- But miss optional fields or use wrong enum values ✗

Example response from Ollama:
```json
{
  "rules": [{
    "name": "Synology",
    "condition": {...},
    "actions": [{
      "type": "DELETE",  // ❌ Invalid - should be "MARK_SPAM"
      "fields": null,
      "delayInMinutes": 1440
    }]
  }]
}
```

Schema expected one of: `LABEL | ARCHIVE | MARK_READ | DRAFT_EMAIL | REPLY | FORWARD | SEND_EMAIL | MARK_SPAM | DIGEST | CALL_WEBHOOK`

#### Issue #2: Missing Optional Fields
For sender categorization, the schema required:
```typescript
{
  rationale: z.string().describe("Keep it short. 1-2 sentences max."),
  category: z.string(),
}
```

Ollama would return:
```json
{
  "category": "Notification"  // Missing 'rationale' field
}
```

#### Issue #3: LiteLLM Parameter Differences

LiteLLM translates between different provider APIs, but Ollama requires specific parameters:

- OpenAI expects: `response_format: { type: "json_schema", schema: {...} }`
- Ollama needs: `format: "json"` (at the root level, not in `response_format`)

The Vercel AI SDK wasn't adding the `format` parameter for LiteLLM/Ollama.

## Solution Implementation

### Solution 1: Custom Fetch Interceptor for `format: "json"`

**File**: `/apps/web/utils/llms/model.ts`

Added a custom fetch function to intercept requests and inject the `format: "json"` parameter:

```typescript
case Provider.OPENAI_COMPATIBLE: {
  const modelName = aiModel || env.OPENAI_COMPATIBLE_MODEL;

  // Ollama models don't support structured outputs the same way as OpenAI
  const supportsStructuredOutputs = !modelName.startsWith("ollama/");

  // Custom fetch to add format: "json" for Ollama models
  const customFetch = async (url: string, options?: RequestInit) => {
    const isOllamaModel = modelName.startsWith("ollama/");

    if (isOllamaModel && options?.body) {
      try {
        const body = JSON.parse(options.body as string);

        // Add format: "json" for JSON mode requests
        if (!body.format) {
          body.format = "json";
          logger.info("Added format: json for Ollama", {
            model: modelName,
          });
          options.body = JSON.stringify(body);
        }
      } catch (e) {
        logger.error("Failed to parse request body in custom fetch", { error: e });
      }
    }

    return fetch(url, options);
  };

  const openaiCompatible = createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    supportsStructuredOutputs,
    fetch: customFetch,  // ← Key addition
    ...(openAiCompatibleApiKey ? { apiKey: openAiCompatibleApiKey } : {}),
  });

  return {
    provider: Provider.OPENAI_COMPATIBLE,
    modelName,
    model: openaiCompatible(modelName),
  };
}
```

**Why this works**: The custom fetch function intercepts every HTTP request to LiteLLM and adds the Ollama-specific `format: "json"` parameter before the request is sent.

### Solution 2: Use `generateText` Instead of `generateObject` for Ollama

**File**: `/apps/web/utils/ai/rule/prompt-to-rules.ts`

For complex schemas like rule creation, bypassed the AI SDK's strict validation entirely:

```typescript
export async function aiPromptToRules({
  emailAccount,
  promptFile,
}: {
  emailAccount: EmailAccountWithAI;
  promptFile: string;
}): Promise<CreateRuleSchema[]> {
  const modelOptions = getModel(emailAccount.user, "chat");

  // For Ollama models, use generateText with manual parsing
  const isOllamaModel = modelOptions.model?.modelId?.startsWith("ollama/");

  if (isOllamaModel) {
    return await aiPromptToRulesOllama({ emailAccount, promptFile, modelOptions });
  }

  // Standard path for OpenAI and other models
  // ... existing generateObject code ...
}

async function aiPromptToRulesOllama({
  emailAccount,
  promptFile,
  modelOptions,
}: {
  emailAccount: EmailAccountWithAI;
  promptFile: string;
  modelOptions: ReturnType<typeof getModel>;
}): Promise<CreateRuleSchema[]> {
  const system = getSystemPrompt(emailAccount.account.provider, true);
  const cleanedPromptFile = convertMentionsToLabels(promptFile);

  const prompt = `Convert the following prompt file into rules:

<prompt>
${cleanedPromptFile}
</prompt>

Return ONLY valid JSON matching the schema shown in the system prompt. No markdown, no explanations.`;

  const generateText = createGenerateText({
    emailAccount,
    label: "Prompt to rules (Ollama)",
    modelOptions,
  });

  const aiResponse = await generateText({
    ...modelOptions,
    prompt,
    system,
  });

  logger.info("Ollama raw response", { text: aiResponse.text.substring(0, 1000) });

  // Clean up the response - remove markdown code blocks if present
  let jsonText = aiResponse.text.trim();
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.replace(/^```json\n/, "").replace(/\n```$/, "");
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```\n/, "").replace(/\n```$/, "");
  }

  // Repair any JSON issues
  const repairedJson = jsonrepair(jsonText);
  logger.info("Repaired JSON", { json: repairedJson.substring(0, 1000) });

  // Parse and validate
  const parsed = JSON.parse(repairedJson);
  const schema = z.object({
    rules: z.array(createRuleSchema(emailAccount.account.provider)),
  });

  const validated = schema.parse(parsed);
  return validated.rules;
}
```

**Why this works**:
1. Uses `generateText()` which just gets raw text response
2. Manually cleans up markdown formatting
3. Uses `jsonrepair` to fix common JSON issues
4. Only validates AFTER we have clean JSON
5. Provides better error messages when validation fails

### Solution 3: Enhanced System Prompts with Examples

**File**: `/apps/web/utils/ai/rule/prompt-to-rules.ts`

Added explicit examples and constraints for Ollama models:

```typescript
function getSystemPrompt(provider: string, includeExample: boolean = false) {
  const basePrompt = `You are an AI assistant that converts email management rules into a structured format...`;

  if (!includeExample) {
    return basePrompt;
  }

  // For models without structured output support (like Ollama), include a complete example
  const exampleRule = {
    name: "Marketing",
    condition: {
      conditionalOperator: null,
      aiInstructions: "Apply to marketing and promotional emails from newsletters",
      static: {
        from: null,
        to: null,
        subject: null
      }
    },
    actions: [
      {
        type: "ARCHIVE",
        fields: null,
        delayInMinutes: null
      },
      {
        type: "LABEL",
        fields: {
          label: "Marketing",
          to: null,
          cc: null,
          bcc: null,
          subject: null,
          content: null,
          webhookUrl: null
        },
        delayInMinutes: null
      }
    ]
  };

  return `${basePrompt}

IMPORTANT: Your response must EXACTLY match this JSON structure:

{
  "rules": [
    ${JSON.stringify(exampleRule, null, 2)}
  ]
}

Key points:
- Each rule MUST have a "condition" object with "conditionalOperator", "aiInstructions", and "static" fields
- Each action MUST be an object with "type", "fields", and "delayInMinutes"
- Valid action types: LABEL, ARCHIVE, MARK_READ, DRAFT_EMAIL, REPLY, FORWARD, SEND_EMAIL, MARK_SPAM, DIGEST, CALL_WEBHOOK
- To delete emails, use MARK_SPAM (not DELETE)
- Set fields to null if not needed
- Use null values, not undefined or missing fields`;
}
```

**Why this works**:
- Provides a concrete example of the exact structure needed
- Lists valid enum values explicitly
- Clarifies common mistakes (DELETE vs MARK_SPAM)
- Emphasizes the importance of null vs undefined

### Solution 4: Make Optional Fields Truly Optional

**File**: `/apps/web/utils/ai/categorize-sender/ai-categorize-single-sender.ts`

For simpler schemas like categorization, made optional fields actually optional:

```typescript
const aiResponse = await generateObject({
  ...modelOptions,
  system,
  prompt,
  schema: z.object({
    rationale: z
      .string()
      .describe("Keep it short. 1-2 sentences max.")
      .optional(),  // ← Made optional
    category: z.string(),
  }),
});
```

**Why this works**: Ollama models are less reliable at including all fields. By making non-critical fields optional, we can still get useful results even if the model omits them.

## Testing and Verification

### Test Case 1: Rule Creation
**Input**: "Emails from Synology Notification System - Synology NAS notifications with [T6-1602] in subject"

**Expected Output**:
```json
{
  "rules": [{
    "name": "Synology",
    "condition": {
      "conditionalOperator": null,
      "aiInstructions": "Emails from Synology Notification System <sns@synologynotification.com> containing [T6-1602]",
      "static": {
        "from": "sns@synologynotification.com",
        "to": null,
        "subject": null
      }
    },
    "actions": [
      {
        "type": "LABEL",
        "fields": {
          "label": "Synology",
          "to": null,
          "cc": null,
          "bcc": null,
          "subject": null,
          "content": null,
          "webhookUrl": null
        },
        "delayInMinutes": null
      },
      {
        "type": "MARK_SPAM",
        "fields": null,
        "delayInMinutes": 1440
      }
    ]
  }]
}
```

**Result**: ✅ Success
```
[createRules]: Completed { createdRules: 1, failedRules: 0 }
```

### Test Case 2: Email Categorization
**Input**: Automated email processing for `sns@synologynotification.com`

**Expected Output**:
```json
{
  "category": "Notification"
}
```

**Result**: ✅ Success
```
Gmail inbox processing completed { processed: 2, failed: 0 }
```

## Architectural Decisions

### Why Not Use a Transformation Layer?

**Considered**: Creating a middleware that transforms Ollama responses to match OpenAI's structured output format.

**Rejected because**:
- Adds complexity and potential failure points
- Would require reverse-engineering OpenAI's exact response format
- Wouldn't solve the fundamental issue that Ollama can't guarantee schema compliance
- Harder to debug and maintain

### Why Dual Code Paths (OpenAI vs Ollama)?

**Decision**: Maintain separate logic for Ollama models vs other models.

**Rationale**:
- **Performance**: OpenAI's native structured outputs are faster and more reliable when available
- **Reliability**: Don't degrade the experience for users with OpenAI models
- **Simplicity**: Each path is simpler than trying to make one path work for both
- **Future-proof**: Easy to add support for other model types

**Trade-offs**:
- Slightly more code to maintain
- Need to keep both paths in sync for schema changes
- But: Clear separation of concerns makes debugging easier

### Why Not Switch to a Different Model?

**User Requirements**:
- Self-hosted/local deployment (privacy concerns)
- Cost considerations (120B parameter model)
- Already running Ollama infrastructure

**Our Response**: Make the system work with user's preferred model rather than forcing them to use specific providers.

## Lessons Learned

### 1. Provider API Differences Are Significant

Different LLM providers have fundamentally different capabilities:
- **Structured outputs**: OpenAI yes, Ollama no
- **Function calling**: OpenAI yes, most others limited
- **Streaming**: Different formats and capabilities

**Takeaway**: Don't assume "OpenAI-compatible" means feature parity.

### 2. The AI SDK Makes Assumptions

The Vercel AI SDK is optimized for OpenAI's API. When using other providers:
- Check what features are actually supported
- Be prepared to implement custom fetch/transform logic
- Test thoroughly with actual provider responses

### 3. Explicit Prompting Is Critical for Open Models

Open-source models need more explicit guidance:
- Provide concrete examples
- List valid enum values explicitly
- Specify edge cases (null vs undefined, etc.)
- Be very clear about required vs optional fields

### 4. Graceful Degradation Works

For non-critical fields (like `rationale` in categorization):
- Making them optional maintains functionality
- User experience is only slightly degraded
- Better than complete failure

## Future Improvements

### 1. Schema-Aware Prompt Generation

Automatically generate better prompts from Zod schemas for Ollama models:

```typescript
function generateSchemaPrompt(schema: ZodSchema): string {
  // Extract required fields, types, enums
  // Generate natural language description
  // Include examples for complex types
}
```

### 2. Response Validation with Retry

Add intelligent retry logic:

```typescript
async function generateWithRetry(prompt, schema, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await generateText(prompt);
    try {
      return schema.parse(JSON.parse(response));
    } catch (error) {
      // Append validation error to prompt for next attempt
      prompt += `\n\nPrevious attempt failed: ${error.message}. Please fix and try again.`;
    }
  }
  throw new Error("Failed after retries");
}
```

### 3. Model Capability Detection

Auto-detect which features a model supports:

```typescript
interface ModelCapabilities {
  structuredOutputs: boolean;
  functionCalling: boolean;
  streaming: boolean;
  maxTokens: number;
}

function detectCapabilities(modelName: string): ModelCapabilities {
  // Test or use known capability database
}
```

### 4. Better Error Messages

When validation fails, provide actionable feedback:

```typescript
function formatValidationError(error: ZodError, response: string): string {
  return `
Schema validation failed:
${error.issues.map(i => `- ${i.path.join('.')}: ${i.message}`).join('\n')}

Received response:
${response}

Expected structure:
${generateSchemaExample(schema)}
`;
}
```

## Configuration Reference

### Environment Variables

```bash
# LLM Provider Configuration
DEFAULT_LLM_PROVIDER=openai-compatible
DEFAULT_LLM_MODEL=kimi-k2                    # LiteLLM alias — NOT ollama/kimi-k2:1t-cloud
ECONOMY_LLM_PROVIDER=openai-compatible
ECONOMY_LLM_MODEL=kimi-k2

# LiteLLM Proxy Configuration
OPENAI_COMPATIBLE_BASE_URL=http://nuc.lan:4000/v1
LLM_API_KEY=your-litellm-api-key
```

> **Important**: Use LiteLLM model name aliases (e.g., `kimi-k2`) not raw Ollama paths (e.g., `ollama/kimi-k2:1t-cloud`). The raw path triggers `isOllamaModel` detection in the app code, which adds `format: json` and disables structured outputs — breaking tool calling.

### Model Detection Logic

```typescript
// In /apps/web/utils/llms/model.ts
const isOllamaModel = modelName.startsWith("ollama/");

// In /apps/web/utils/ai/rule/prompt-to-rules.ts
const isOllamaModel = modelOptions.model?.modelId?.startsWith("ollama/");
```

### Files Modified

1. `/apps/web/utils/llms/model.ts` - Custom fetch interceptor, disabled structured outputs
2. `/apps/web/utils/ai/rule/prompt-to-rules.ts` - Dual path for Ollama vs OpenAI
3. `/apps/web/utils/ai/categorize-sender/ai-categorize-single-sender.ts` - Optional rationale field
4. `/apps/web/utils/llms/index.ts` - Enhanced repair logging

## Troubleshooting Guide

### Issue: "No object generated: response did not match schema"

**Check**:
1. Is `format: "json"` being added? Look for log: `"Added format: json for Ollama"`
2. Is the model using the Ollama code path? Look for: `"Prompt to rules (Ollama)"`
3. Check the raw response: `"Ollama raw response"`
4. Check the repaired JSON: `"Repaired JSON"`

**Fix**: If any of the above logs are missing, the code path isn't being triggered correctly. Verify model name starts with `ollama/`.

### Issue: Invalid enum values (e.g., DELETE instead of MARK_SPAM)

**Check**: System prompt includes valid action types?

**Fix**: Update system prompt to explicitly list valid values and provide examples.

### Issue: Missing required fields

**Options**:
1. Make the field optional in the schema (if non-critical)
2. Add more explicit examples in the prompt
3. Add field to the example in the system prompt

### Issue: Frontend shows loading forever

**Cause**: Stale Server Action IDs after multiple rebuilds

**Fix**: Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)

## Conclusion

The integration of Ollama models required understanding the fundamental differences between OpenAI's structured outputs and Ollama's JSON mode. By implementing model-specific code paths, custom fetch interceptors, and enhanced prompting strategies, we successfully enabled Ollama model support while maintaining excellent UX for OpenAI users.

**Key Success Factors**:
1. ✅ Understanding provider API differences
2. ✅ Implementing appropriate abstractions (dual code paths)
3. ✅ Using `generateText` + manual validation for complex schemas
4. ✅ Providing explicit examples and constraints in prompts
5. ✅ Making non-critical fields optional for graceful degradation

**Current Status**: Ollama Cloud models fully working for structured output, rule creation, email categorization, and AI chat tool calling.

---

## Ollama Cloud Models — Tool Calling Fix (2026-03-24)

### Background: What Are Ollama Cloud Models?

Ollama Cloud lets you run large models remotely via Ollama's cloud infrastructure while using the same local Ollama server. You add a `:cloud` suffix to the model tag:

- `kimi-k2:1t-cloud` — Kimi K2 1T MoE (32B active), 256K context
- `gpt-oss:120b-cloud` — GPT-OSS 120B
- `kimi-k2-thinking:cloud` — Kimi K2 with extended reasoning

These route through `http://localhost:11434` (your local Ollama) which proxies to Ollama's cloud.

### Problem: AI Chat Tool Calling Broken

The AI chat assistant has 17+ tools (searchInbox, getUserRulesAndSettings, createRule, etc.) that use OpenAI-compatible function calling. When using Ollama Cloud models, the model was outputting tool calls as **raw JSON text** in the message content:

```
{"name": "getUserRulesAndSettings", "arguments": {}}
```

Instead of using the proper `tool_calls` response field:

```json
{
  "choices": [{
    "message": {
      "tool_calls": [{
        "function": { "name": "getUserRulesAndSettings", "arguments": "{}" },
        "id": "functions.getUserRulesAndSettings:0",
        "type": "function"
      }]
    }
  }]
}
```

### Root Causes

**1. LiteLLM: Wrong Ollama endpoint prefix**

Using `ollama/kimi-k2:1t-cloud` routes through Ollama's `/api/generate` endpoint, which does **NOT** support tool calling. The `/api/chat` endpoint does.

| LiteLLM Prefix | Ollama Endpoint | Tool Calling |
|----------------|-----------------|--------------|
| `ollama/`      | `/api/generate` | No           |
| `ollama_chat/` | `/api/chat`     | Yes          |

**2. App .env: `ollama/` prefix triggering unwanted code paths**

The model name `ollama/kimi-k2:1t-cloud` in `.env` triggered `isOllamaModel = true` in the custom fetch interceptor, which:
- Added `format: "json"` to all requests (breaking tool calls)
- Disabled `supportsStructuredOutputs`

**3. `format: "json"` conflicts with tool calling**

When `format: json` is in the request body, the model is forced to emit everything as JSON content. This overrides the model's ability to use the structured `tool_calls` response field.

### Solution: Three-Layer Fix

#### Layer 1: LiteLLM Config — Use `ollama_chat/` prefix

**File**: `/opt/asus-rog-nuc-ai-stack/configs/litellm/config.yaml`

```yaml
# BEFORE (broken)
- model_name: kimi-k2
  litellm_params:
    model: ollama/kimi-k2:1t-cloud
    api_base: http://nuc.lan:11434

# AFTER (working)
- model_name: kimi-k2
  litellm_params:
    model: ollama_chat/kimi-k2:1t-cloud    # /api/chat endpoint
    api_base: http://nuc.lan:11434
    timeout: 600
    stream_timeout: 120
  model_info:
    supports_function_calling: true          # prevent LiteLLM from emulating tools
```

**Why**: `ollama_chat/` tells LiteLLM to use Ollama's `/api/chat` endpoint which returns proper `tool_calls` in the response. `supports_function_calling: true` prevents LiteLLM from falling back to its JSON-mode tool call emulation.

#### Layer 2: App .env — Drop `ollama/` prefix, use LiteLLM alias

```bash
# BEFORE
DEFAULT_LLM_MODEL=ollama/kimi-k2:1t-cloud   # triggers isOllamaModel=true

# AFTER
DEFAULT_LLM_MODEL=kimi-k2                    # LiteLLM alias, isOllamaModel=false
```

**Why**: By using the LiteLLM `model_name` alias (not the raw Ollama model path), the app treats it as a regular OpenAI-compatible model. No special Ollama code paths are triggered. LiteLLM handles the Ollama-specific translation.

#### Layer 3: Code — Skip `format:json` when tools are present

**File**: `/apps/web/utils/llms/model.ts`

```typescript
// BEFORE — added format:json to ALL Ollama requests
if (!body.format) {
  body.format = "json";

// AFTER — skip when tools are present
const hasTools = body.tools && body.tools.length > 0;
if (!body.format && !hasTools) {
  body.format = "json";
```

**Why**: Safety net for models that still go through the `ollama/` code path (e.g., local models used for structured output). `format: json` is correct for `generateObject()` calls but breaks `tool_calls` responses.

### Verification

Direct API test confirmed tool calling works in both streaming and non-streaming modes:

```bash
# Non-streaming — tool_calls in message
curl -X POST http://nuc.lan:4000/v1/chat/completions \
  -d '{"model": "kimi-k2", "messages": [...], "tools": [...], "stream": false}'
# Response: "finish_reason": "tool_calls", "tool_calls": [{"function": {"name": "get_weather"}}]

# Streaming — tool_calls in delta
curl -X POST ... -d '{"stream": true}'
# Response: "delta": {"tool_calls": [{"function": {"name": "get_weather"}}]}
```

### Architecture: When to Use Which Prefix

| Use Case | .env Model Name | LiteLLM Config Model | Why |
|----------|----------------|---------------------|-----|
| AI Chat (tool calling) | `kimi-k2` | `ollama_chat/kimi-k2:1t-cloud` | Needs `/api/chat` for tool_calls |
| Structured output (generateObject) | `ollama/gpt-oss:20b` | `ollama/gpt-oss:20b` | `format:json` + `/api/generate` works fine |
| Thinking/reasoning | `kimi-k2-thinking` | `ollama/kimi-k2-thinking:cloud` | No tools needed, just text |

### Key Takeaway

When using Ollama Cloud models with LiteLLM for **tool calling**:
1. Use `ollama_chat/` prefix in LiteLLM config (not `ollama/`)
2. Set `supports_function_calling: true` in `model_info`
3. Use the LiteLLM alias in `.env` (not the raw `ollama/` path)
4. Never add `format: json` to requests that include `tools`
