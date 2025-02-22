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
const USER_POOL_ID = "eu-west-1_hgUDdjyRr"; // process.env.USER_POOL_ID;
const USERS_TABLE = "UsersTable"; // process.env.USERS_TABLE;
const CITY_TABLE = "City"; //  process.env.CITY_TABLE;
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
      email,
      lastName,
      collegeId,
    } = event;

    if (!userID || !city) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Invalid input: userID, and city are required.",
        }),
      };
    }

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
    console.log(newRole);
    console.log("Fetching CityID for city:", city.toLowerCase());
    console.log("City Table:", CITY_TABLE);
    console.log("City CITY_INDEX:", CITY_INDEX);
    console.log(QueryCommand);

    console.log("username for Cognito ", userName);
    const existingCognitoAttributes = await getCognitoAttributes(userName);
    console.log("Existing Cognito Attributes:", existingCognitoAttributes);

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
      updatedAttributes = [{ Name: "custom:role", Value: newRole }];
    }

    if (cityID) {
      updatedAttributes.push({ Name: "custom:CityID", Value: cityID });
      updatedAttributes.push({ Name: "custom:City", Value: city });
    }

    let finalCollegeDetails = collegeDetails;

    // Fetch college details if collegeId is provided but collegeDetails are missing
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
      // If CollegeID is removed, remove it from Cognito
      updatedAttributes.push({ Name: "custom:CollegeID", Value: "" });
    }

    console.log("Updating Cognito attributes:", updatedAttributes);
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: userName,
        UserAttributes: updatedAttributes,
      })
    );

    const setExpressions = ["#role = :role"];
    const removeExpressions = [];
    const expressionAttributeNames = { "#role": "role" };
    const expressionAttributeValues = { ":role": newRole || "user" };

    //   const updateExpression = ["SET  #role = :role"];
    //  const expressionAttributeNames = { "#role": "role" };
    //  const expressionAttributeValues = { ":role": newRole };

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
      // Remove collegeDetails if it existed before
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
    if (email) {
      setExpressions.push("#EmailAddress = :email");
      expressionAttributeNames["#EmailAddress"] = "Email";
      expressionAttributeValues[":email"] = email;
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
      return {};
    }

    return unmarshall(response.Item) || {};
  } catch (error) {
    console.error("Error fetching College details:", error);
    return {};
  }
}

// Query Cognito to get existing attributes
async function getCognitoAttributes(userName) {
  try {
    console.log("getCognitoAttributes", userName);
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
