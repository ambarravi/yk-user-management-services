import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const client = new DynamoDBClient({ region });

export async function handler(event) {
  console.log(JSON.stringify(event));

  const city = event.queryStringParameters?.city || "";
  const searchText = event.queryStringParameters?.searchText || "";

  if (!city) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "city is required" }),
    };
  }

  const input = {
    TableName: "College", // Your table name
    IndexName: "City-index", // Name of the GSI
    KeyConditionExpression: "City = :city", // Partition key condition
    ExpressionAttributeValues: {
      ":city": { S: "pune" }, // Replace "pune" with the desired city
    },
    Select: "ALL_ATTRIBUTES", // Retrieve all attributes
  };

  async function queryDynamoDB() {
    try {
      const command = new QueryCommand(input);
      const response = await client.send(command);
      console.log("Query succeeded:", response.Items);
      return {
        statusCode: 200,
        body: JSON.stringify(response.Items || []),
      };
    } catch (error) {
      console.error("Error querying DynamoDB:", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Error querying data" }),
      };
    }
  }

  const response = await queryDynamoDB();
  return response;
}
