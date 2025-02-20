import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr";
const USERS_TABLE = "UsersTable";
const CITY_TABLE = "City";
const CITY_INDEX = "CityName-index";
const COLLEGE_TABLE = "College";

const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  console.log("Event: ", JSON.stringify(event));

  try {
    const { userName, userID, city, collegeDetails, collegeId, tempRole } =
      event;

    if (!userID || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid input: userID and city are required.",
        }),
      };
    }

    // Fetch existing user attributes from Cognito
    const existingCognitoAttributes = await getCognitoAttributes(userName);
    console.log("Existing Cognito Attributes:", existingCognitoAttributes);

    // Fetch existing user details from DynamoDB
    const existingDynamoData = await getDynamoUser(userID);
    console.log("Existing DynamoDB Data:", existingDynamoData);

    // Get cityID from City table
    let cityID = await queryCityTable(city);
    console.log("Found CityID:", cityID || "City not found");

    let updatedAttributes = [];

    if (cityID) {
      updatedAttributes.push({ Name: "custom:CityID", Value: cityID });
      updatedAttributes.push({ Name: "custom:City", Value: city });
    }

    let finalCollegeDetails = collegeDetails;

    // Fetch college details if collegeId is provided but collegeDetails are missing
    if (collegeId && !collegeDetails) {
      console.log(`Fetching details for collegeId: ${collegeId}`);
      finalCollegeDetails = await fetchCollegeDetails(collegeId);
    }

    if (finalCollegeDetails?.CollegeID) {
      updatedAttributes.push({
        Name: "custom:CollegeID",
        Value: finalCollegeDetails.CollegeID,
      });
    } else if (existingCognitoAttributes["custom:CollegeID"]) {
      // If CollegeID is removed, remove it from Cognito
      updatedAttributes.push({ Name: "custom:CollegeID", Value: "" });
    }

    // Add tempRole to Cognito attributes
    if (tempRole) {
      updatedAttributes.push({ Name: "custom:role", Value: tempRole });
    }

    console.log("Updating Cognito Attributes:", updatedAttributes);
    if (updatedAttributes.length > 0) {
      await cognitoClient.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: userName,
          UserAttributes: updatedAttributes,
        })
      );
    }

    // Update DynamoDB
    //  let updateExpression = ["set #cityID = :cityID"];

    let setExpressions = ["#cityID = :cityID"];
    let removeExpressions = [];

    let expressionAttributeNames = { "#cityID": "CityID" };
    let expressionAttributeValues = { ":cityID": cityID };

    if (finalCollegeDetails?.CollegeID) {
      //  updateExpression.push("#collegeDetails = :collegeDetails");
      setExpressions.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = finalCollegeDetails;
    } else if (existingDynamoData.collegeDetails && !finalCollegeDetails) {
      // Remove collegeDetails if it existed before
      //updateExpression.push("REMOVE #collegeDetails");
      removeExpressions.push("#collegeDetails");
    }

    // Add tempRole to DynamoDB update
    if (tempRole) {
      //updateExpression.push("#role = :role");
      setExpressions.push("#role = :role");
      expressionAttributeNames["#role"] = "role";
      expressionAttributeValues[":role"] = tempRole;
    }

    if (
      !setExpressions.includes("#collegeDetails = :collegeDetails") &&
      !removeExpressions.includes("#collegeDetails")
    ) {
      delete expressionAttributeNames["#collegeDetails"];
    }

    let updateExpression = [];
    if (setExpressions.length > 0) {
      updateExpression.push("SET " + setExpressions.join(", "));
    }
    if (removeExpressions.length > 0) {
      updateExpression.push("REMOVE " + removeExpressions.join(", "));
    }
    console.log("Final UpdateExpression: ", updateExpression.join(" "));

    console.log("Updating DynamoDB...");
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ UserID: userID }),
        UpdateExpression: updateExpression.join(" "),
        ExpressionAttributeNames: expressionAttributeNames || undefined,
        ExpressionAttributeValues: Object.keys(expressionAttributeValues).length
          ? marshall(expressionAttributeValues)
          : undefined,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "City, College, and Role updated successfully",
        cityID: cityID,
        collegeDetails: finalCollegeDetails,
        role: tempRole,
      }),
    };
  } catch (error) {
    console.error("Error: ", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
    };
  }
};

// Query Cognito to get existing attributes
async function getCognitoAttributes(userName) {
  try {
    const response = await cognitoClient.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userName,
      })
    );
    return response.UserAttributes.reduce((acc, attr) => {
      acc[attr.Name] = attr.Value;
      return acc;
    }, {});
  } catch (error) {
    console.error("Error fetching Cognito attributes:", error);
    return {};
  }
}

// Query DynamoDB to get existing user data
async function getDynamoUser(userID) {
  try {
    const response = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ UserID: userID }),
      })
    );
    return response.Item ? unmarshall(response.Item) : {};
  } catch (error) {
    console.error("Error fetching DynamoDB user data:", error);
    return {};
  }
}

// Query DynamoDB for CityID
async function queryCityTable(city) {
  try {
    const params = {
      TableName: CITY_TABLE,
      IndexName: CITY_INDEX,
      KeyConditionExpression: "#city = :city",
      ExpressionAttributeNames: { "#city": "CityName" },
      ExpressionAttributeValues: { ":city": { S: city.toLowerCase() } },
    };

    const response = await dynamoDBClient.send(new QueryCommand(params));
    console.log("DynamoDB Response:", response.Items.length);

    if (response.Items.length === 0) {
      return null;
    }

    return unmarshall(response.Items[0])?.CityID || null;
  } catch (error) {
    console.error("Error querying CITY_TABLE:", error);
    return null;
  }
}

const fetchCollegeDetails = async (collegeId) => {
  try {
    const params = {
      TableName: COLLEGE_TABLE,
      Key: { CollegeID: { S: collegeId } },
    };

    const { Item } = await dynamoDBClient.send(new GetItemCommand(params));

    if (!Item) {
      console.log(`College not found for ID: ${collegeId}`);
      return null;
    }

    return unmarshall(Item);
  } catch (error) {
    console.error("Error fetching college details:", error);
    return null;
  }
};
