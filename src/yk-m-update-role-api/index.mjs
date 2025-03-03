import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr"; // Ensure this matches your Cognito User Pool ID
const USERS_TABLE = "UsersTable";
const CITY_TABLE = "City";
const CITY_INDEX = "CityName-index";
const COLLEGE_TABLE = "College";
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
      email: providedEmail,
      lastName,
      collegeId,
      phoneNumber,
    } = event;

    if (!userID || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid input: userID and city are required.",
        }),
      };
    }

    let cognitoIdentifier = providedEmail;
    if (!cognitoIdentifier && userName) {
      const cognitoAttributes = await getCognitoAttributes(userName);
      cognitoIdentifier = cognitoAttributes["email"];
      if (!cognitoIdentifier) {
        console.warn(
          "No email found in Cognito attributes for userName:",
          userName
        );
      }
    }

    // Proceed even if cognitoIdentifier is missing (Cognito update will be skipped)
    console.log("Using cognitoIdentifier:", cognitoIdentifier || "None");

    let newRole;
    let roleupdateRequired = false;
    if (
      currentRole &&
      currentRole.toLowerCase().includes(tempRole.toLowerCase())
    ) {
      roleupdateRequired = false;
    } else {
      roleupdateRequired = true;
      newRole = currentRole
        ? `${currentRole.toLowerCase()},${tempRole.toLowerCase()}`
        : tempRole.toLowerCase();
    }
    console.log("New Role:", newRole);

    console.log("Fetching CityID for city:", city.toLowerCase());
    let existingCognitoAttributes = {};
    if (cognitoIdentifier) {
      existingCognitoAttributes = await getCognitoAttributes(cognitoIdentifier);
      console.log("Existing Cognito Attributes:", existingCognitoAttributes);
    } else {
      console.warn(
        "Skipping Cognito attribute fetch due to missing identifier"
      );
    }

    const existingDynamoData = await getDynamoUser(userID);
    console.log("Existing DynamoDB Data:", existingDynamoData);

    let cityID = await queryCityTable(city);
    if (cityID) {
      console.log("Found CityID:", cityID);
    } else {
      console.log("City not found in DynamoDB.");
    }

    let updatedAttributes = [];
    if (roleupdateRequired) {
      updatedAttributes.push({ Name: "custom:role", Value: newRole });
    }
    if (cityID) {
      updatedAttributes.push({ Name: "custom:CityID", Value: cityID });
      updatedAttributes.push({ Name: "custom:City", Value: city });
    }
    if (phoneNumber) {
      updatedAttributes.push({ Name: "phone_number", Value: phoneNumber });
    }
    if (name) {
      updatedAttributes.push({ Name: "given_name", Value: name });
    }
    if (lastName) {
      updatedAttributes.push({ Name: "family_name", Value: lastName });
    }

    let finalCollegeDetails = collegeDetails;
    if (collegeId && Object.keys(collegeDetails).length === 0) {
      console.log(`Fetching details for collegeId: ${collegeId}`);
      finalCollegeDetails = (await fetchCollegeDetails(collegeId)) || {};
    }
    if (finalCollegeDetails.CollegeID) {
      updatedAttributes.push({
        Name: "custom:CollegeID",
        Value: finalCollegeDetails.CollegeID,
      });
    } else if (existingCognitoAttributes["custom:CollegeID"]) {
      updatedAttributes.push({ Name: "custom:CollegeID", Value: "" });
    }

    if (cognitoIdentifier && updatedAttributes.length > 0) {
      console.log(
        "Updating Cognito attributes with identifier:",
        cognitoIdentifier
      );
      console.log("Attributes to update:", updatedAttributes);
      await cognitoClient.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: cognitoIdentifier,
          UserAttributes: updatedAttributes,
        })
      );
    } else {
      console.warn(
        "Skipping Cognito update: No identifier or attributes to update"
      );
    }

    const setExpressions = ["#role = :role"];
    const removeExpressions = [];
    const expressionAttributeNames = { "#role": "role" };
    const expressionAttributeValues = { ":role": newRole || "user" };

    if (cityID) {
      setExpressions.push("#cityID = :cityID");
      expressionAttributeNames["#cityID"] = "CityID";
      expressionAttributeValues[":cityID"] = cityID;
    }
    if (finalCollegeDetails?.CollegeID) {
      setExpressions.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = finalCollegeDetails;
    } else if (existingDynamoData.collegeDetails) {
      removeExpressions.push("#collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
    }
    if (name) {
      setExpressions.push("#name = :FirstName");
      expressionAttributeNames["#name"] = "FirstName";
      expressionAttributeValues[":FirstName"] = name;
    }
    if (lastName) {
      setExpressions.push("#lastName = :LastName");
      expressionAttributeNames["#lastName"] = "LastName";
      expressionAttributeValues[":LastName"] = lastName;
    }
    if (providedEmail) {
      setExpressions.push("#EmailAddress = :email");
      expressionAttributeNames["#EmailAddress"] = "Email";
      expressionAttributeValues[":email"] = providedEmail;
    }
    if (phoneNumber) {
      setExpressions.push("#phoneNumber = :phoneNumber");
      expressionAttributeNames["#phoneNumber"] = "PhoneNumber";
      expressionAttributeValues[":phoneNumber"] = phoneNumber;
    }

    let finalUpdateExpression = "SET " + setExpressions.join(", ");
    if (removeExpressions.length > 0) {
      finalUpdateExpression += " REMOVE " + removeExpressions.join(", ");
    }

    console.log("Final Update Expression:", finalUpdateExpression);

    console.log("Updating USERS_TABLE with cityID and other details");
    await dynamoDBClient.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { UserID: userID },
        UpdateExpression: finalUpdateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Role and attributes updated successfully",
        cityID: cityID,
        collegeDetails: finalCollegeDetails,
        followingCount: existingDynamoData.FollowingCount ?? 0,
        eventsAttended: existingDynamoData.eventsAttended ?? 0,
        fname: name || existingDynamoData.FirstName || "N/A",
        lname: lastName || existingDynamoData.LastName || "N/A",
        phoneNumber: phoneNumber || existingDynamoData.PhoneNumber,
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
      return null;
    }

    const unmarshalledItems = response.Items.map((item) => unmarshall(item));
    console.log("Query succeeded:", unmarshalledItems);

    return unmarshalledItems[0]?.CityID || null;
  } catch (error) {
    console.error("Error querying CITY_TABLE:", error);
    return null;
  }
}

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
      return {};
    }

    return unmarshall(response.Item) || {};
  } catch (error) {
    console.error("Error fetching College details:", error);
    return {};
  }
}

async function getCognitoAttributes(identifier) {
  try {
    console.log("getCognitoAttributes with identifier:", identifier);
    const response = await cognitoClient.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: identifier,
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
