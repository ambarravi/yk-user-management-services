import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr"; // process.env.USER_POOL_ID;
const USERS_TABLE = "UsersTable"; // process.env.USERS_TABLE;
const CITY_TABLE = "City"; //  process.env.CITY_TABLE;
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

    if (!userID || !tempRole || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid input: userID, tempRole, and city are required.",
        }),
      };
    }

    let newRole;
    if (
      currentRole &&
      currentRole.toLowerCase().includes(tempRole.toLowerCase())
    ) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Role is already updated or included",
        }),
      };
    } else {
      newRole = currentRole
        ? `${currentRole.toLowerCase()},${tempRole.toLowerCase()}`
        : tempRole.toLowerCase();
    }
    console.log(newRole);
    console.log("Fetching CityID for city:", city.toLowerCase());
    console.log("City Table:", CITY_TABLE);
    console.log("City CITY_INDEX:", CITY_INDEX);
    console.log(QueryCommand);

    let cityID = await queryCityTable(city);
    if (cityID) {
      console.log("Found CityID:", cityID);
    } else {
      console.log("City not found in DynamoDB.");
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

async function queryCityTable(city) {
  try {
    const params = {
      TableName: CITY_TABLE,
      IndexName: CITY_INDEX,
      KeyConditionExpression: "#city = :city",
      ExpressionAttributeNames: { "#city": "CityName" },
      ExpressionAttributeValues: marshall({ ":city": city.toLowerCase() }),
    };

    const command = new QueryCommand(params);
    const response = await dynamoDBClient.send(command);

    console.log("DynamoDB Response:", response.Items.length);

    if (response.Items.length === 0) {
      console.log("No city found for:", city);
      return null; // Return null if no city is found
    }

    // Unmarshall the response items
    const unmarshalledItems = response.Items.map((item) => unmarshall(item));

    console.log("Query succeeded:", unmarshalledItems);

    return unmarshalledItems[0]?.CityID || null; // Return CityID or null
  } catch (error) {
    console.error("Error querying CITY_TABLE:", error);
    return null;
  }
}
