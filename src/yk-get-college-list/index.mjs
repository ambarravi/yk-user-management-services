import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const dynamoDB = new DynamoDBClient({ region });

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

  const params = {
    TableName: "College",
    IndexName: "City-index",
    KeyConditionExpression: "City = :city",
    ExpressionAttributeValues: {
      ":city": city,
      ":searchText": searchText,
    },
    // FilterExpression:
    //   "contains(#nameAttr, :searchText) OR begins_with(#shortformAttr, :searchText)",
    //  FilterExpression: "contains(#nameAttr, :searchText)",
    // FilterExpression: "begins_with(#shortformAttr, :searchText)",
    ExpressionAttributeNames: {
      "#nameAttr": "Name", // Replace 'Name' with actual attribute name if different
      "#shortformAttr": "Shortform", // Replace 'Shortform' with actual attribute name if different
    },
  };

  try {
    console.log("Params:", params);
    const result = await dynamoDB.send(new QueryCommand(params));
    console.log("Query result:", JSON.stringify(result, null, 2));
    return {
      statusCode: 200,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error querying DynamoDB:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error querying data" }),
    };
  }
}
