// validateCollegeNameAI.js
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
}); // Change region if needed

export async function validateCollegeNameAI(collegeName) {
  const prompt = `
You are an AI college name validator.
Given this name: "${collegeName}"
Check if it looks like a legitimate college or university name.
Reject names that:
- Are test data (e.g., "test", "abc", "demo")
- Contain profanity or inappropriate words
- Are too short (<3 words usually)
- Are nonsensical or joke names
Respond in JSON with keys:
{ "valid": true/false, "reason": "short reason if invalid" }
`;

  const input = {
    modelId: "anthropic.claude-3-haiku-20240307-v1:0", // Change model if needed
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  };

  const command = new InvokeModelCommand(input);
  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const textOutput = responseBody.content?.[0]?.text || "{}";

  try {
    return JSON.parse(textOutput);
  } catch {
    return {
      valid: false,
      reason: "Validation failed due to AI response error.",
    };
  }
}
