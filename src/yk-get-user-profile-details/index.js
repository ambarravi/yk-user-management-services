import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));
    const TABLE = process.env.USERS_TABLE;
    let body = JSON.parse(event.body);
    let userID = body.userID;

    if (!userID) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message: "Missing userID" }),
      };
    }

    const getParams = {
      TableName: TABLE,
      Key: {
        UserID: { S: userID },
      },
    };

    console.log("Get params:", JSON.stringify(getParams));

    const result = await dynamoDBClient.send(new GetItemCommand(getParams));

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message: "User not found" }),
      };
    }

    // Extracting values from DynamoDB response
    const user = {
      UserID: result.Item.UserID?.S || null,
      FirstName: result.Item.FirstName?.S || "",
      LastName: result.Item.LastName?.S || "",
      Email: result.Item.Email?.S || "",
      City: result.Item.city?.S || "",
      Role: result.Item.role?.S || "",
      CollegeDetails: result.Item.collegeDetails
        ? {
            City: result.Item.collegeDetails.City?.S || "",
            CollegeID: result.Item.collegeDetails.CollegeID?.S || "",
            Name: result.Item.collegeDetails.Name?.S || "",
            Shortform: result.Item.collegeDetails.Shortform?.S || "",
            University: result.Item.collegeDetails.University?.S || "",
          }
        : {},
      FollowingCount: result.Item.FollowingCount?.N
        ? parseInt(result.Item.FollowingCount.N)
        : 0,
      EventParticipatedCount: result.Item.EventParticipatedCount?.N
        ? parseInt(result.Item.EventParticipatedCount.N)
        : 0,
    };

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(user),
    };
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};
