import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

export async function validateCollegeNameAI(collegeName, { city, cityId }) {
  console.log(
    `Validating college: ${collegeName} in city: ${city}, cityId: ${cityId}`
  );

  // Validate inputs
  if (!collegeName || typeof collegeName !== "string" || !collegeName.trim()) {
    const result = {
      valid: false,
      reason: "College name is empty or invalid.",
      suggestions: [],
      verified: false,
    };
    console.log(`Validation result: ${JSON.stringify(result)}`);
    return result;
  }
  if (!city || typeof city !== "string" || !city.trim()) {
    const result = {
      valid: false,
      reason: "City is empty or invalid.",
      suggestions: [],
      verified: false,
    };
    console.log(`Validation result: ${JSON.stringify(result)}`);
    return result;
  }

  const prompt = `
You are an AI college name validator and suggestion generator.
Given the college name "${collegeName}" in city "${city}", perform the following:

1. **Validation**:
   - Check if "${collegeName}" is a legitimate college or university name.
   - Reject names that:
     - Are test data (e.g., "test", "abc", "demo").
     - Contain profanity or inappropriate words (e.g., "fuck", "shit").
     - Are too short (fewer than 3 characters or 1-2 words unless well-known).
     - Are fictional or joke names (e.g., "Hogwarts", "X-Men Academy").
     - Are nonsensical or meaningless.
   - If valid but not a known college, mark as unverified.

2. **Suggestions**:
   - If the name is valid but unverified, suggest up to 5 real college or university names in "${city}" that are similar to "${collegeName}" (e.g., based on name similarity, keywords, or institution type).
   - If the name is invalid, return an empty suggestions array.

Respond ONLY in JSON with the following structure:
{
  "valid": true/false,
  "reason": "short reason for validation status",
  "suggestions": ["college name 1", "college name 2", ...],
  "verified": false
}

Rules for "verified":
- Always set "verified": false (verification happens in backend DB check).

Example:
For collegeName: "Indira college", city: "Pune":
{
  "valid": true,
  "reason": "Looks valid but unverified.",
  "suggestions": ["Indira College of Commerce and Science", "Fergusson College", "Symbiosis College"],
  "verified": false
}
`;

  const input = {
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 300, // Increased to accommodate suggestions
      messages: [{ role: "user", content: prompt }],
    }),
  };

  try {
    const command = new InvokeModelCommand(input);
    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const textOutput = responseBody.content?.[0]?.text || "{}";

    console.log("Bedrock textOutput:", textOutput);
    const result = JSON.parse(textOutput);

    // Ensure verified is false and suggestions is an array
    const finalResult = {
      valid: result.valid || false,
      reason:
        result.reason ||
        (result.valid ? "Looks valid but unverified." : "Rejected."),
      suggestions: Array.isArray(result.suggestions)
        ? result.suggestions.slice(0, 5)
        : [],
      verified: false,
    };

    console.log(`Validation result: ${JSON.stringify(finalResult)}`);
    return finalResult;
  } catch (error) {
    console.error("Error invoking Bedrock:", error);
    return {
      valid: false,
      reason: "Validation failed due to AI response error.",
      suggestions: [],
      verified: false,
    };
  }
}
