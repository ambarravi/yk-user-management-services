import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const client = new DynamoDBClient({ region });

export async function handler(event) {
  const city = (event.queryStringParameters?.city || "").toLowerCase().trim();
  const searchText = (event.queryStringParameters?.searchText || "")
    .toLowerCase()
    .trim();
  console.log("Request parameters:", JSON.stringify({ city, searchText }));

  if (!city || !searchText) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "city and searchText are required" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  }

  const input = {
    TableName: "College",
    IndexName: "City-index",
    KeyConditionExpression: "City = :city",
    ExpressionAttributeValues: {
      ":city": { S: city },
      ":searchText": { S: searchText },
    },
    FilterExpression:
      "contains(#nameLower, :searchText) OR begins_with(#shortformLower, :searchText)",
    ExpressionAttributeNames: {
      "#nameLower": "NameLower",
      "#shortformLower": "ShortformLower",
    },
    Select: "ALL_ATTRIBUTES",
  };

  async function queryDynamoDB() {
    try {
      const command = new QueryCommand(input);
      console.log("Query input:", JSON.stringify(input, null, 2));
      const response = await client.send(command);
      const unmarshalledItems = response.Items.map((item) => unmarshall(item));
      console.log(
        "Query succeeded:",
        JSON.stringify(unmarshalledItems, null, 2)
      );
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(unmarshalledItems || []),
      };
    } catch (error) {
      console.error("Error querying DynamoDB:", error);
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Error querying data" }),
      };
    }
  }

  return await queryDynamoDB();
}
