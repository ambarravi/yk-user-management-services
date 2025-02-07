import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const USERS_TABLE = process.env.USERS_TABLE;
const CITY_TABLE = process.env.CITY_TABLE;
const CITY_INDEX = "CityName-index";
const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

export const handler = async (event) => {
  console.log("Event: ", JSON.stringify(event));

  try {
    const {
      userName,
      userID,
      tempRole,
      currentRole,
      city,
      collegeDetails,
      name,
      email,
      lastName,
    } = event;

    if (!userID || !tempRole || !currentRole || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message:
            "Invalid input: userID, tempRole, currentRole, and city are required.",
        }),
      };
    }

    let newRole;
    if (currentRole.toLowerCase().includes(tempRole.toLowerCase())) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Role is already updated or included",
        }),
      };
    } else {
      newRole = `${currentRole.toLowerCase()},${tempRole.toLowerCase()}`;
    }

    console.log("Fetching CityID for city:", city.toLowerCase());
    let cityID;
    const cityQueryResult = await dynamoDBClient.send(
      new QueryCommand({
        TableName: CITY_TABLE,
        IndexName: CITY_INDEX,
        KeyConditionExpression: "#city = :city",
        ExpressionAttributeNames: { "#city": "CityName" },
        ExpressionAttributeValues: { ":city": city.toLowerCase() },
      })
    );

    if (cityQueryResult.Items.length > 0) {
      cityID = cityQueryResult.Items[0].CityID;
      console.log("Found CityID:", cityID);
    }

    let updatedAttributes = [{ Name: "custom:role", Value: newRole }];
    if (cityID)
      updatedAttributes.push({ Name: "custom:CityID", Value: cityID });

    if (collegeDetails && collegeDetails.CollegeID) {
      updatedAttributes.push({
        Name: "custom:CollegeID",
        Value: collegeDetails.CollegeID,
      });
    }

    console.log("Updating Cognito attributes:", updatedAttributes);
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userName,
        UserAttributes: updatedAttributes,
      })
    );

    const updateExpression = ["set #role = :role"];
    const expressionAttributeNames = { "#role": "role" };
    const expressionAttributeValues = { ":role": newRole };

    if (cityID) {
      updateExpression.push("#cityID = :cityID");
      expressionAttributeNames["#cityID"] = "CityID";
      expressionAttributeValues[":cityID"] = cityID;
    }

    if (collegeDetails) {
      updateExpression.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = collegeDetails;
    }
    if (name) {
      updateExpression.push("#name = :FirstName");
      expressionAttributeNames["#name"] = "FirstName";
      expressionAttributeValues[":FirstName"] = name;
    }
    if (lastName) {
      updateExpression.push("#lastName = :LastName");
      expressionAttributeNames["#lastName"] = "LastName";
      expressionAttributeValues[":LastName"] = lastName;
    }
    if (email) {
      updateExpression.push("#EmailAddress = :email");
      expressionAttributeNames["#EmailAddress"] = "Email";
      expressionAttributeValues[":email"] = email;
    }

    console.log("Updating USERS_TABLE with cityID and other details");
    await dynamoDBClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { UserID: userID },
        UpdateExpression: updateExpression.join(", "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Role and attributes updated successfully",
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
