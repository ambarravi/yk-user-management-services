import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
const region = process.env.AWS_REGION || "eu-west-1"; // Fallback for local testing
const client = new DynamoDBClient({ region });
const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*", // For prod, restrict to your domain
};
export async function handler(event) {
  const city = (event.queryStringParameters?.city || "").toLowerCase().trim();
  const searchText = (event.queryStringParameters?.search || "")
    .toLowerCase()
    .trim();
  console.log("Request parameters:", JSON.stringify({ city, searchText }));
  if (!city) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "city is required" }),
    };
  } // Base params for Query
  const baseParams = {
    TableName: "College",
    IndexName: "City-index",
    KeyConditionExpression: "City = :city",
    ExpressionAttributeValues: { ":city": { S: city } },
  }; // Add filter if searchText provided
  let input = { ...baseParams };
  if (searchText) {
    input.FilterExpression =
      "contains(#nameLower, :searchText) OR begins_with(#shortformLower, :searchText)";
    input.ExpressionAttributeNames = {
      "#nameLower": "NameLower",
      "#shortformLower": "ShortformLower",
    };
    input.ExpressionAttributeValues = {
      ...input.ExpressionAttributeValues, // Merge to avoid overwrite
      ":searchText": { S: searchText },
    };
  }
  async function queryDynamoDB() {
    try {
      console.log("Query input:", JSON.stringify(input, null, 2));
      const command = new QueryCommand(input);
      const response = await client.send(command);
      const unmarshalledItems = (response.Items || []).map((item) =>
        unmarshall(item)
      );
      console.log(
        "Query succeeded:",
        JSON.stringify(unmarshalledItems, null, 2)
      );
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(unmarshalledItems), // React expects array directly
      };
    } catch (error) {
      console.error("Error querying DynamoDB:", error);
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Error querying data",
          details: error.message,
        }), // More debug info
      };
    }
  }
  return await queryDynamoDB();
}
