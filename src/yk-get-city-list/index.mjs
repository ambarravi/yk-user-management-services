import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb"; // Import unmarshall utility

const region = process.env.AWS_REGION || "eu-west-1"; // Default region
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  try {
    const params = {
      TableName: "City",
    };

    const result = await dynamoDB.send(new ScanCommand(params));

    // Convert DynamoDB AttributeValue format to plain JSON
    const cities = result.Items
      ? result.Items.map((item) => unmarshall(item))
      : [];

    console.log("Query result:", cities);

    return {
      statusCode: 200,
      body: JSON.stringify(cities), // Return plain JSON
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
