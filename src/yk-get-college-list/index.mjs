import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

import { unmarshall } from "@aws-sdk/util-dynamodb"; // Import unmarshall utility

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

  // const input = {
  //   TableName: "College", // Your table name
  //   IndexName: "City-index", // Name of the GSI
  //   KeyConditionExpression: "City = :city", // Partition key condition
  //   ExpressionAttributeValues: {
  //     ":city": { S: city }, // Replace "pune" with the desired city
  //     ":searchText": { S: searchText }, // Additional filter condition
  //   },
  //   FilterExpression: "contains(#nameAttr, :searchText)", // Filter to check if Name contains "Engineering"
  //   ExpressionAttributeNames: {
  //     "#nameAttr": "Name", // Attribute name mapping
  //   },
  //   Select: "ALL_ATTRIBUTES", // Retrieve all attributes
  // };

  const input = {
    TableName: "College", // Your table name
    IndexName: "City-index", // Name of the GSI
    KeyConditionExpression: "City = :city", // Partition key condition
    ExpressionAttributeValues: {
      ":city": { S: city }, // Replace "pune" with the desired city
      ":searchText": { S: searchText }, // Additional filter condition for "Name"
      ":shortformPrefix": { S: searchText }, // Additional filter condition for "Shortform"
    },
    FilterExpression:
      "contains(#nameAttr, :searchText) OR begins_with(#shortformAttr, :shortformPrefix)", // Filter criteria
    ExpressionAttributeNames: {
      "#nameAttr": "Name", // Attribute name mapping for "Name"
      "#shortformAttr": "Shortform", // Attribute name mapping for "Shortform"
    },
    Select: "ALL_ATTRIBUTES", // Retrieve all attributes
  };

  async function queryDynamoDB() {
    try {
      const command = new QueryCommand(input);
      const response = await client.send(command);
      const unmarshalledItems = response.Items.map((item) => unmarshall(item));
      console.log("Query succeeded:", unmarshalledItems);
      return {
        statusCode: 200,
        body: JSON.stringify(unmarshalledItems || []),
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
