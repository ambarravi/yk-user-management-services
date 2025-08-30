import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION; // Default region
const dynamoDB = new DynamoDBClient({ region });
import { unmarshall } from "@aws-sdk/util-dynamodb"; // Import unmarshall utility

export async function handler(event) {
  try {
    const params = {
      TableName: "Category",
    };

    const result = await dynamoDB.send(new ScanCommand(params));

    // Convert DynamoDB AttributeValue format to plain JSON
    const categories = result.Items
      ? result.Items.map((item) => unmarshall(item))
      : [];

    console.log("Scan result:", categories);
    return {
      statusCode: 200,
      body: JSON.stringify(categories),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // CORS headers
      },
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // CORS headers
      },
    };
  }
}
