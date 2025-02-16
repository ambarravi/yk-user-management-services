import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
//const client = new DynamoDBClient({ region: "eu-west-1"  });
const ddbClient = new DynamoDBClient({ region: "eu-west-1" });

const USER_ORG_TABLE = "UserOrganizationFollow";
const ORGANIZER_TABLE = "Organizer";
const USER_TABLE = "UsersTable";

/**
 * Lambda function to handle Follow/Unfollow action
 */
export const handler = async (event) => {
  try {
    const { userId, orgId, status } = JSON.parse(event.body);

    // ✅ Step 1: Validate input
    if (
      !userId ||
      !orgId ||
      !status ||
      !["Follow", "UnFollow"].includes(status)
    ) {
      return response(400, {
        message:
          "Invalid input. Required: userId, orgId, status (Follow/UnFollow)",
      });
    }

    const timestamp = Math.floor(Date.now() / 1000); // Epoch time
    const userPK = `USER#${userId}`;
    const orgSK = `ORG#${orgId}`;

    // ✅ Step 2: Check if user is already following the organizer
    const existingFollow = await getFollowRecord(userPK, orgSK);
    console.log(existingFollow);
    if (status === "Follow") {
      if (existingFollow) {
        return response(200, {
          message: "You are already following this organizer.",
        });
      }

      // ✅ Step 3: Insert Follow record in `UserOrganizationFollow`
      console.log("followOrganizer");
      await followOrganizer(userPK, orgSK, timestamp);

      // ✅ Step 4: Update organizer's follower count
      console.log("updateCount , ORG");
      await updateCount(
        ORGANIZER_TABLE,
        "OrganizerID",
        orgId,
        "FollowerCount",
        1
      );

      // ✅ Step 5: Update user’s following count
      console.log("updateCount , User");
      await updateCount(USER_TABLE, "UserID", userId, "FollowingCount", 1);
      const followerCount = await getFollowerCount(orgId);
      return response(200, {
        message: `Successfully ${status.toLowerCase()}ed the organizer.`,
        followerCount,
      });
    } else if (status === "UnFollow") {
      if (!existingFollow) {
        return response(400, {
          message: "You are not following this organizer.",
        });
      }

      // ✅ Step 6: Delete Follow record in `UserOrganizationFollow`
      await unfollowOrganizer(userPK, orgSK);

      // ✅ Step 7: Decrease organizer's follower count
      await updateCount(
        ORGANIZER_TABLE,
        "OrganizerID",
        orgId,
        "FollowerCount",
        -1
      );

      // ✅ Step 8: Decrease user’s following count
      await updateCount(USER_TABLE, "UserID", userId, "FollowingCount", -1);
      const followerCount = await getFollowerCount(orgId);
      return response(200, {
        message: "Successfully unfollowed the organizer.",
        followerCount,
      });
    }
  } catch (error) {
    console.error("Error processing request:", error);
    return response(500, { message: "Internal Server Error" });
  }
};

/**
 * Fetch Follow Record from UserOrganizationFollow Table
 */
async function getFollowRecord(userPK, orgSK) {
  console.log("getFollowRecord");
  console.log("userPK:", userPK);
  console.log("orgSK:", orgSK);

  const key = {
    UserID: { S: userPK },
    OrgID: { S: orgSK },
  };

  console.log("Formatted Key:", JSON.stringify(key, null, 2));

  const command = new GetItemCommand({
    TableName: USER_ORG_TABLE,
    Key: key,
  });

  console.log("GetItemCommand Input:", command.input);

  const result = await ddbClient.send(command);
  console.log("getFollowRecord result:", JSON.stringify(result, null, 2));

  if (!result.Item) {
    console.warn(`No record found for UserID: ${userPK} and OrgID: ${orgSK}`);
    return null;
  }

  return result.Item;
}

/**
 * Insert Follow Record in UserOrganizationFollow Table
 */
async function followOrganizer(userPK, orgSK, timestamp) {
  console.log("followOrganizer", userPK, orgSK);
  const command = new PutItemCommand({
    TableName: USER_ORG_TABLE,
    Item: {
      UserID: { S: userPK },
      OrgID: { S: orgSK },
      Timestamp: { N: timestamp.toString() },
    },
  });

  await ddbClient.send(command);
}

/**
 * Delete Follow Record in UserOrganizationFollow Table
 */
async function unfollowOrganizer(userPK, orgSK) {
  console.log("UserPK:", userPK);
  console.log("OrgSK:", orgSK);

  if (!userPK || typeof userPK !== "string") {
    throw new Error(`Invalid userPK: ${JSON.stringify(userPK)}`);
  }
  if (!orgSK || typeof orgSK !== "string") {
    throw new Error(`Invalid orgSK: ${JSON.stringify(orgSK)}`);
  }

  const command = new DeleteItemCommand({
    TableName: USER_ORG_TABLE,
    Key: {
      UserID: { S: userPK },
      OrgID: { S: orgSK },
    },
  });

  console.log(
    "DeleteItemCommand Input:",
    JSON.stringify(command.input, null, 2)
  );

  try {
    const result = await ddbClient.send(command);
    console.log("Delete Result:", JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error("Delete failed:", error);
    throw error;
  }
}

/**
 * Update Count (Follow/Unfollow) in Organizer or UserTable
 */
async function updateCount(table, pkName, idValue, field, increment) {
  console.log("Table:", table);
  console.log("Primary Key Name:", pkName);
  console.log("Primary Key Value:", idValue);
  console.log("Field to Increment:", field);
  console.log("Increment Value:", increment);

  const command = new UpdateItemCommand({
    TableName: table,
    Key: { [pkName]: { S: idValue } }, // Dynamically use the correct PK name
    UpdateExpression: `SET ${field} = if_not_exists(${field}, :zero) + :inc`,
    ExpressionAttributeValues: {
      ":zero": { N: "0" }, // Correct type (number)
      ":inc": { N: increment.toString() }, // Convert increment to string for DynamoDB
    },
    ReturnValues: "UPDATED_NEW",
  });

  console.log(
    "UpdateItemCommand Input:",
    JSON.stringify(command.input, null, 2)
  );

  try {
    const result = await ddbClient.send(command);
    console.log("Update Result:", JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error("Update failed:", error);
    throw error;
  }
}

/**
 * Helper function to format API responses
 */
function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function getFollowerCount(orgId) {
  const command = new GetItemCommand({
    TableName: ORGANIZER_TABLE,
    Key: { OrganizerID: { S: orgId } },
    ProjectionExpression: "FollowerCount",
  });

  const result = await ddbClient.send(command);
  return result.Item?.FollowerCount?.N
    ? parseInt(result.Item.FollowerCount.N, 10)
    : 0;
}
