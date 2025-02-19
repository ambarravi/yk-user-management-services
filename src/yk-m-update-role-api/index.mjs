import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateCommand,
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
    const { userName, userID, city, collegeDetails, collegeId } = event;

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

    console.log("Updating Cognito Attributes:", updatedAttributes);
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userName,
        UserAttributes: updatedAttributes,
      })
    );

    // Update DynamoDB
    let updateExpression = ["set #cityID = :cityID"];
    let expressionAttributeNames = { "#cityID": "CityID" };
    let expressionAttributeValues = { ":cityID": cityID };

    if (finalCollegeDetails?.CollegeID) {
      updateExpression.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = finalCollegeDetails;
    } else if (existingDynamoData.collegeDetails) {
      // Remove collegeDetails if it existed before
      updateExpression.push("REMOVE #collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
    }

    console.log("Updating DynamoDB...");
    await dynamoDBClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: marshall({ UserID: userID }),
        UpdateExpression: updateExpression.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "City and College updated successfully",
        cityID: cityID,
        collegeDetails: finalCollegeDetails,
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
      ExpressionAttributeValues: marshall({ ":city": city.toLowerCase() }),
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

// Fetch College Details from College Table
async function fetchCollegeDetails(CollegeID) {
  try {
    const response = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: COLLEGE_TABLE,
        Key: marshall({ CollegeID }),
      })
    );

    if (!response.Item) {
      console.log(`CollegeID ${CollegeID} not found in College table`);
      return null;
    }

    return unmarshall(response.Item);
  } catch (error) {
    console.error("Error fetching College details:", error);
    return null;
  }
}
