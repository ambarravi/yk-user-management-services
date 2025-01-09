import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  console.log(event);
  const searchText = event.queryStringParameters?.searchText || "";

  if (!searchText) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Search text is required" }),
    };
  }

  const queries = [
    {
      TableName: "College",
      IndexName: "Name-index",
      KeyConditionExpression: "begins_with(Name, :searchText)",
      ExpressionAttributeValues: {
        ":searchText": searchText,
      },
    },
    {
      TableName: "College",
      IndexName: "Shortform-index",
      KeyConditionExpression: "begins_with(Shortform, :searchText)",
      ExpressionAttributeValues: {
        ":searchText": searchText,
      },
    },
  ];

  try {
    const [collegeNameResults, shortformResults] = await Promise.all(
      queries.map((query) => dynamoDB.send(new QueryCommand(query)))
    );

    // Combine results and remove duplicates based on CollegeID
    const combinedResults = [
      ...(collegeNameResults.Items || []),
      ...(shortformResults.Items || []),
    ];

    const uniqueResults = Array.from(
      new Map(combinedResults.map((item) => [item.CollegeID.S, item])).values()
    );

    return {
      statusCode: 200,
      body: JSON.stringify(uniqueResults),
    };
  } catch (error) {
    console.error("Error querying DynamoDB:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch colleges" }),
    };
  }
}
