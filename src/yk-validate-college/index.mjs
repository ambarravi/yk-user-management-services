import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

export const handler = async (event) => {
  console.log(event);
  console.log("String", JSON.stringify(event));
  const { collegeName, city } = event;

  console.log(`Validating college: ${collegeName} in city: ${city}`);

  // Validate inputs
  if (!collegeName || typeof collegeName !== "string" || !collegeName.trim()) {
    const result = {
      valid: false,
      reason: "College name is empty or invalid.",
      suggestions: [],
      verified: false,
    };
    console.log(`Validation result: ${JSON.stringify(result)}`);
    return {
      statusCode: 200,
      body: JSON.stringify(result.suggestions),
    };
  }
  if (!city || typeof city !== "string" || !city.trim()) {
    const result = {
      valid: false,
      reason: "City is empty or invalid.",
      suggestions: [],
      verified: false,
    };
    console.log(`Validation result: ${JSON.stringify(result)}`);
    return {
      statusCode: 200,
      body: JSON.stringify(result.suggestions),
    };
  }

  const prompt = `
You are an AI college name validator and suggestion generator.
Given the college name "${collegeName}" in city "${city}", perform the following:

1. **Validation**:
   - Check if "${collegeName}" is a plausible college or university name in "${city}".
   - Reject names that:
     - Are test data (e.g., "test", "abc", "demo").
     - Contain profanity or inappropriate words (e.g., "fuck", "shit", "damn").
     - Are too short (fewer than 3 characters or 1-2 words unless well-known, e.g., "IIT", "MIT").
     - Are fictional or joke names (e.g., "Hogwarts", "X-Men Academy").
     - Are nonsensical or unrelated to educational institutions.
   - If the name seems valid but is not a known college, mark as unverified.

2. **Suggestions**:
   - **Primary Step**: Search for colleges in "${city}" whose names closely match "${collegeName}" (e.g., contain the same keywords, start with the same word, or are phonetically similar). For example, if "${collegeName}" is "Bharathi", prioritize colleges like "Bharati Vidyapeeth" or "Bharathi College".
   - **Secondary Step**: If no close matches are found, consider other keywords in "${collegeName}" (e.g., "engineering", "college", "institute") or institution type (e.g., engineering college, arts college) to suggest up to 5 relevant colleges in "${city}".
   - **Fallback Step**: If no matches are found based on name or keywords, return the top 5 well-known colleges in "${city}", prioritizing those matching any specified faculty (e.g., engineering if "engineering" is in "${collegeName}").
   - Include the area or neighborhood in suggestion names for clarity (e.g., "Bharati Vidyapeeth, Katraj").
   - If the name is invalid, return an empty suggestions array.
   - Ensure suggestions are real institutions in "${city}".

3. **Area Name Handling**:
   - If "${collegeName}" includes an area name (e.g., "Indira College Wakad"), use it to refine validation and prioritize suggestions from that area of "${city}".
   - Include the area in suggestion names where applicable.

Respond ONLY in JSON with the following structure:
{
  "valid": boolean,
  "reason": "short reason for validation status",
  "suggestions": ["college name 1 with area", "college name 2 with area", ...],
  "verified": false
}

Rules:
- Limit suggestions to a maximum of 5.
- Always set "verified": false (final verification happens in backend DB).
- Prioritize name similarity for suggestions, then keywords or faculty, then top colleges.
- Include area or neighborhood in suggestion names for user clarity.

Example:
For collegeName: "Bharathi Engineering", city: "Pune":
{
  "valid": true,
  "reason": "Looks valid but unverified.",
  "suggestions": [
    "Bharati Vidyapeeth College of Engineering, Katraj",
    "Bharati Vidyapeeth Institute of Technology, Dhankawadi",
    "College of Engineering, Shivajinagar",
    "Vishwakarma Institute of Technology, Bibwewadi",
    "Pune Institute of Computer Technology, Dhankawadi"
  ],
  "verified": false
}
`;

  const input = {
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  };

  try {
    const command = new InvokeModelCommand(input);
    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    let textOutput = responseBody.content?.[0]?.text || "{}";

    console.log("Bedrock textOutput:", textOutput);

    // Extract JSON from textOutput, removing any preamble
    const jsonMatch = textOutput.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in response");
    }
    const jsonString = jsonMatch[0];

    // Parse the extracted JSON
    const result = JSON.parse(jsonString);

    // Ensure verified is false and suggestions is limited to 5
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
    return {
      statusCode: 200,
      body: JSON.stringify(finalResult.suggestions), // Return only suggestions array for UI compatibility
    };
  } catch (error) {
    console.error("Error invoking Bedrock:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        valid: false,
        reason: `Validation failed: ${error.message}`,
        suggestions: [],
        verified: false,
      }),
    };
  }
};
