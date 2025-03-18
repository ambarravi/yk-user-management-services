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
    console.log("DDB result", JSON.stringify(result));
    const user = {
      userID: result.Item.UserID?.S || null,
      name: result.Item.FirstName?.S || "",
      lastName: result.Item.LastName?.S || "",
      email: result.Item.Email?.S || "",
      city: result.Item.City?.S || "",
      cityId: result.Item.CityID?.S || "",
      role: result.Item.role?.S || "",
      phoneNumber: result.Item.PhoneNumber?.S || "",
      collegeDetails: result.Item.collegeDetails?.M
        ? {
            city: result.Item.collegeDetails.M.City?.S || "",
            collegeID: result.Item.collegeDetails.M.CollegeID?.S || "",
            name: result.Item.collegeDetails.M.Name?.S || "",
            shortform: result.Item.collegeDetails.M.Shortform?.S || "",
            university: result.Item.collegeDetails.M.University?.S || "",
            cityID: result.Item.collegeDetails.M.CityID?.S || "",
          }
        : {},
      followingCount: result.Item.FollowingCount?.N
        ? parseInt(result.Item.FollowingCount.N)
        : 0,
      eventParticipatedCount: result.Item.EventParticipatedCount?.N
        ? parseInt(result.Item.EventParticipatedCount.N)
        : 0,
      mobile: result.Item.Mobile?.S || "N/A",
      createdAt: result.Item.CreatedAt?.S || "",
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
