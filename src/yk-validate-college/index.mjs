const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*", // For prod, restrict to your domain
};

export const handler = async (event) => {
  console.log(event.body);
  const bodyString = event.body;

  console.log("Parsing request body...");
  console.log(bodyString);
  let bodyJson;
  try {
    bodyJson = JSON.parse(bodyString);
  } catch (error) {
    console.error("Failed to parse request body:", error);
    const errorResult = {
      valid: false,
      reason: "Invalid JSON format in request body.",
      suggestions: [],
      verified: false,
    };
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify(errorResult), // Return full error object
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
      headers: corsHeaders,
      body: JSON.stringify(result), // Return full result object
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
      headers: corsHeaders,
      body: JSON.stringify(result), // Return full result object
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
  //console.log(apiKey);
  // **************** CRITICAL FIX *******************
  // Change the deprecated model name to the stable version.
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  // *************************************************

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

      // Handle Rate Limiting (429) - Retryable Error
      if (response.status === 429) {
        retries++;
        const delay = Math.pow(2, retries) * 1000; // Exponential backoff
        console.warn(
          `API rate limit exceeded. Retrying in ${delay / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Handle other non-ok responses (including 400 Bad Request) - Non-retryable
      if (!response.ok) {
        // Log the response body for detailed error analysis
        const errorBody = await response.text();
        console.error(
          `Gemini API Error Status: ${response.status}. Body: ${errorBody}`
        );
        // For 400, throw the error and break the retry loop immediately
        throw new Error(
          `API call failed with status: ${
            response.status
          }. Reason: ${errorBody.substring(0, 100)}...`
        );
      }

      const rawResult = await response.json();

      // Simplified parsing of the structured JSON output
      const candidates = rawResult.candidates || [];
      if (candidates.length > 0 && candidates[0].content?.parts?.length > 0) {
        const jsonText = candidates[0].content.parts[0].text;
        result = JSON.parse(jsonText);
      } else {
        throw new Error("Invalid or empty response structure from Gemini API");
      }

      break; // Success, exit the loop
    } catch (error) {
      console.error("Error invoking Gemini API:", error);
      retries++;
      // If the error is not 429 and not a rate limit issue, stop retrying.
      if (retries >= maxRetries || error.message.indexOf("429") === -1) {
        break;
      }
      const delay = Math.pow(2, retries) * 1000;
      console.warn(`Request failed. Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Handle case where all retries fail
  if (!result) {
    const errorResult = {
      valid: false,
      reason:
        "API call failed after multiple retries. Check logs for 400 error body.",
      suggestions: [],
      verified: false,
    };
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify(errorResult), // Return full error object
    };
  }

  // Final formatting and cleanup
  const finalResult = {
    valid: result.valid === true,
    reason:
      result.reason ||
      (result.valid
        ? "Looks valid but unverified."
        : "Rejected by model logic."),
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    verified: false,
  };

  // Enforce suggestion emptiness if invalid
  if (finalResult.valid === false) {
    finalResult.suggestions = [];
  }

  console.log(`Final validation result: ${JSON.stringify(finalResult)}`);

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify(finalResult),
  };
};
