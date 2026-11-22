-- Personal data stays on local models: every saved model choice moves to Flint through LiteLLM.
UPDATE "User"
SET "aiProvider" = 'litellm', "aiModel" = 'recursivesi/flint', "aiApiKey" = NULL
WHERE ("aiProvider" IS NOT NULL OR "aiApiKey" IS NOT NULL)
  AND NOT (
    "aiProvider" IS NOT DISTINCT FROM 'litellm'
    AND "aiModel" IS NOT DISTINCT FROM 'recursivesi/flint'
    AND "aiApiKey" IS NULL
  );
