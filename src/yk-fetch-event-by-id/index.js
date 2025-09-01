import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    const origin = event.headers.origin || event.headers.Origin;
    console.log("Input event:", JSON.stringify(event));

    const TABLE_EVENT = "EventDetails";
    const TABLE_ORGANIZER = "Organizer";
    const TABLE_USER_FOLLOW = "UserOrganizationFollow";

    let body = JSON.parse(event.body);
    let eventID = body.eventID;
    let userID = body.userId;

    console.log("Fetching Event Details...");

    // **Step 1: Fetch Event Details**
    const eventParams = {
      TableName: TABLE_EVENT,
      Key: {
        EventID: { S: eventID },
      },
    };

    const eventResult = await dynamoDBClient.send(
      new GetItemCommand(eventParams)
    );
    const eventDetails = eventResult.Item ? unmarshall(eventResult.Item) : null;

    if (!eventDetails) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Event not found." }),
      };
    }

    const orgId = eventDetails.OrgID;
    console.log("OrgID from Event Details:", orgId);

    // **Step 2: Fetch Organizer Details**
    const orgParams = {
      TableName: TABLE_ORGANIZER,
      Key: {
        OrganizerID: { S: orgId },
      },
    };

    const orgResult = await dynamoDBClient.send(new GetItemCommand(orgParams));
    const orgDetails = orgResult.Item ? unmarshall(orgResult.Item) : null;

    if (!orgDetails) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Organizer details not found." }),
      };
    }

    const followerCount = orgDetails?.FollowerCount ?? 0;
    const logoPath = orgDetails.logoPath || "";

    console.log("Organizer Details:", orgDetails);

    // **Step 3: Check if User is Following Organizer**
    let followFlag = "Not Following";
    console.log("userID", userID);

    if (userID) {
      const userPK = `USER#${userID}`;
      const orgSK = `ORG#${orgId}`;

      const followParams = {
        TableName: TABLE_USER_FOLLOW,
        Key: {
          UserID: { S: userPK },
          OrgID: { S: orgSK },
        },
      };

      const followResult = await dynamoDBClient.send(
        new GetItemCommand(followParams)
      );
      console.log("followResult", followResult);
      if (followResult?.Item && Object.keys(followResult.Item).length > 0) {
        followFlag = "Following";
      }
    }

    console.log("Follow Status:", followFlag);

    // **Step 4: Modify Response to Include OrgDetails**
    const response = {
      ...eventDetails,
      OrgDetails: {
        OrganizerName: orgDetails.OrganizerName,
        FollowerCount: followerCount,
        logoPath: logoPath,
        FollowFlag: followFlag,
        aboutOrganization: orgDetails.aboutOrganization,
        contactPerson: orgDetails.contactPerson,
        contactNumber: orgDetails.contactNumber,
        collegeName: eventDetails.CollegeName,
      },
    };

    console.log("response", response);

    return {
      statusCode: 200,
      headers: getCorsHeaders(origin),
      body: JSON.stringify({ record: response }),
    };
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(origin),
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};

// Helper function to get CORS headers
function getCorsHeaders(origin) {
  console.log("in getCorsHeaders function");

  const allowedOrigins = [
    "http://localhost:3000",
    "https://dom5rgdes5ko4.cloudfront.net",
    "https://d14hm89gkj8tgn.cloudfront.net",
    "https://tikties.com",
    "*",
  ];

  const isOriginAllowed = allowedOrigins.includes(origin);

  console.log("Allowed Origin:", isOriginAllowed);
  return {
    "Access-Control-Allow-Origin": isOriginAllowed
      ? origin
      : "http://localhost:3000",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET, PUT, DELETE",
    "Access-Control-Allow-Credentials": "true",
  };
}
