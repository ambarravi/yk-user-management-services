export const handler = async (event) => {
  console.log(event.body);
  const bodyString = event.body;

  let bodyJson;
  try {
    bodyJson = JSON.parse(bodyString);
  } catch (error) {
    console.error("Failed to parse request body:", error);
    return {
      statusCode: 400,
      body: JSON.stringify({
        valid: false,
        reason: "Invalid JSON format in request body.",
        suggestions: [],
        verified: false,
      }),
    };
  }

  const collegeName = bodyJson.collegeName;
  const city = bodyJson.city;

  console.log(`Validating college: ${collegeName} in city: ${city}`);

  // Initial validation to handle empty inputs before calling the model
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

  // The prompt provided in the user request
  const prompt = `
You are a highly logical, factual, and meticulous AI assistant. Your primary task is to act as a college name validator and suggestion generator. You must adhere strictly to all rules and output a JSON object ONLY.

### Core Task
Given the college name "${collegeName}" and city "${city}", you will first validate the name and then, if valid, provide up to 5 relevant college suggestions.

### Rules and Constraints
- **Validation**:
    - A college name is **INVALID** if it meets ANY of the following conditions:
        1.  It is a test string (e.g., "test", "abc", "demo", "xyz").
        2.  It contains profanity or inappropriate words (e.g., "fuck", "shit", "damn", "chutiya").
        3.  It is a fictional, joke, or nonsensical name (e.g., "Hogwarts", "X-Men Academy", "Nonsense").
        4.  It is too short (fewer than 3 characters or 1-2 words, unless a well-known acronym like "IIT" or "MIT").
    - If the name is determined to be **INVALID**, you **MUST** set "valid" to \`false\`, provide a brief reason, and return an **EMPTY** "suggestions" array.

- **Suggestions**:
    - **Only proceed with suggestion generation if the name is considered VALID.**
    - Suggestions must be real, existing institutions in "${city}".
    - **Prioritize Suggestions based on the following hierarchy:**
        1.  **Primary Match**: Colleges with names that are the closest match to "${collegeName}" (e.g., fuzzy match, abbreviations, key words).
        2.  **Secondary Match**: If no close matches, consider keywords in the input (e.g., "engineering", "institute") to suggest up to 5 relevant colleges of that type.
        3.  **Fallback**: If still no relevant matches, return the top 5 most well-known and reputable colleges in "${city}".
    - Include the area or neighborhood in the suggestion name for clarity (e.g., "College of Engineering, Shivajinagar").
    - **Append a well-known or popular short form after the area name, if one exists (e.g., "Pune Institute of Computer Technology, Dhankawadi, PICT").**
    - Limit the number of suggestions to a maximum of 5.

- **Area Handling**:
    - If "${collegeName}" includes an area name (e.g., "Indira College Wakad"), use it to narrow your search and prioritize suggestions from that specific area of "${city}".

### Output Format
Respond **ONLY** with a JSON object that strictly follows this structure.
{
    "valid": boolean,
    "reason": "A short, precise reason for the validation status.",
    "suggestions": ["college name 1, area, short form", "college name 2, area, short form", ...],
    "verified": false
}

Example:
For collegeName: "Bharathi Engineering", city: "Pune":
{
    "valid": true,
    "reason": "Looks valid but unverified.",
    "suggestions": [
        "Bharati Vidyapeeth College of Engineering, Katraj,",
        "Bharati Vidyapeeth College of Engineering, Lavale,BVCOE",
        "College of Engineering, Shivajinagar, COEP",
        "Vishwakarma Institute of Technology, Bibwewadi,VIT",
        "Pune Institute of Computer Technology, Dhankawadi, PICT"
    ],
    "verified": false
}
`;

  // Define the Gemini API payload to enforce a structured JSON response
  const chatHistory = [
    {
      role: "user",
      parts: [
        {
          text: prompt,
        },
      ],
    },
  ];
  const payload = {
    contents: chatHistory,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          valid: {
            type: "BOOLEAN",
          },
          reason: {
            type: "STRING",
          },
          suggestions: {
            type: "ARRAY",
            items: {
              type: "STRING",
            },
          },
          verified: {
            type: "BOOLEAN",
          },
        },
        propertyOrdering: ["valid", "reason", "suggestions", "verified"],
      },
    },
  };

  const apiKey = process.env.API_KEY;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

  let retries = 0;
  const maxRetries = 5;
  let result;
  while (retries < maxRetries) {
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 429) {
        retries++;
        const delay = Math.pow(2, retries) * 1000; // Exponential backoff
        console.warn(
          `API rate limit exceeded. Retrying in ${delay / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
      }

      const rawResult = await response.json();
      if (
        rawResult.candidates &&
        rawResult.candidates.length > 0 &&
        rawResult.candidates[0].content &&
        rawResult.candidates[0].content.parts &&
        rawResult.candidates[0].content.parts.length > 0
      ) {
        const jsonText = rawResult.candidates[0].content.parts[0].text;
        result = JSON.parse(jsonText);
      } else {
        throw new Error("Invalid response structure from Gemini API");
      }
      break; // Success, exit the loop
    } catch (error) {
      console.error("Error invoking Gemini API:", error);
      retries++;
      const delay = Math.pow(2, retries) * 1000;
      console.warn(`Request failed. Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Handle case where all retries fail
  if (!result) {
    const errorResult = {
      valid: false,
      reason: "API call failed after multiple retries.",
      suggestions: [],
      verified: false,
    };
    return {
      statusCode: 500,
      body: JSON.stringify(errorResult.suggestions),
    };
  }

  // The prompt and response schema should handle the logic, but we'll add a final check
  // to ensure "suggestions" is empty if "valid" is false.
  if (result.valid === false) {
    result.suggestions = [];
  }

  // Ensure the final output matches the requested format, regardless of the model's output
  const finalResult = {
    valid: result.valid || false,
    reason:
      result.reason ||
      (result.valid ? "Looks valid but unverified." : "Rejected."),
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    verified: false,
  };

  console.log(`Final validation result: ${JSON.stringify(finalResult)}`);

  // Return only suggestions array for UI compatibility, as per the original code
  return {
    statusCode: 200,
    body: JSON.stringify(finalResult.suggestions),
  };
};
