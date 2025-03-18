import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr"; // Verify this matches your Cognito User Pool
const USERS_TABLE = "UsersTable";
const CITY_TABLE = "City";
const COLLEGE_TABLE = "College";
const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION }); // Fixed typo here

export const handler = async (event) => {
  console.log("Event: ", JSON.stringify(event));

  try {
    const {
      userName,
      userID, // Maps to Cognito sub
      tempRole,
      currentRole,
      city,
      cityId, // GeoNames cityId from frontend
      state, // State from frontend
      collegeDetails = {},
      name,
      email: providedEmail,
      lastName,
      collegeId,
      phoneNumber,
    } = event;

    if (!userID || !city || !cityId || !state) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message:
            "Invalid input: userID, city, cityId, and state are required.",
        }),
      };
    }

    // Fetch existing DynamoDB data
    const existingDynamoData = await getDynamoUser(userID);
    console.log("Existing DynamoDB Data:", existingDynamoData);

    let cognitoIdentifier = userID; // Use sub (e.g., 22158404-2031-705a-6f55-cf7aef9552b1)
    if (!cognitoIdentifier) {
      cognitoIdentifier = existingDynamoData.Email || providedEmail || userName;
      console.warn("userID not provided, falling back to:", cognitoIdentifier);
    }
    if (cognitoIdentifier === "NA" || cognitoIdentifier === "Unknown") {
      cognitoIdentifier = null;
    }

    console.log("Using cognitoIdentifier:", cognitoIdentifier || "None");

    // Fetch Cognito attributes if we have a valid identifier
    let existingCognitoAttributes = {};
    if (cognitoIdentifier) {
      try {
        existingCognitoAttributes = await getCognitoAttributes(
          cognitoIdentifier
        );
        console.log("Existing Cognito Attributes:", existingCognitoAttributes);
      } catch (error) {
        console.warn("Failed to fetch Cognito attributes:", error);
      }
    }

    // Role logic
    let newRole;
    let roleUpdateRequired = false;
    if (
      currentRole &&
      currentRole.toLowerCase().includes(tempRole.toLowerCase())
    ) {
      roleUpdateRequired = false;
    } else {
      roleUpdateRequired = true;
      newRole = currentRole
        ? `${currentRole.toLowerCase()},${tempRole.toLowerCase()}`
        : tempRole.toLowerCase();
    }
    console.log("New Role:", newRole);

    // Step 1: Ensure city exists in City table with state
    const finalCityId = await ensureCityExists(city, cityId, state);
    console.log("Final CityID:", finalCityId);

    // Prepare Cognito updates
    let updatedAttributes = [];
    if (roleUpdateRequired) {
      updatedAttributes.push({ Name: "custom:role", Value: newRole });
    }
    updatedAttributes.push({ Name: "custom:City_Code", Value: finalCityId });
    updatedAttributes.push({ Name: "custom:City", Value: city });
    updatedAttributes.push({ Name: "custom:State", Value: state });
    if (phoneNumber) {
      updatedAttributes.push({ Name: "phone_number", Value: phoneNumber });
    }
    if (name) {
      updatedAttributes.push({ Name: "given_name", Value: name });
    }
    if (lastName) {
      updatedAttributes.push({ Name: "family_name", Value: lastName });
    }

    // Handle college details
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

    // Update Cognito if we have an identifier and attributes to update
    if (cognitoIdentifier && updatedAttributes.length > 0) {
      console.log("Updating Cognito attributes for:", cognitoIdentifier);
      console.log("Attributes to update:", updatedAttributes);
      try {
        await cognitoClient.send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: USER_POOL_ID,
            Username: cognitoIdentifier,
            UserAttributes: updatedAttributes,
          })
        );
      } catch (error) {
        console.warn("Failed to update Cognito attributes:", error);
      }
    } else {
      console.warn("Skipping Cognito update: No identifier or attributes");
    }

    // Prepare DynamoDB updates for UsersTable
    const setExpressions = ["#role = :role"];
    const removeExpressions = [];
    const expressionAttributeNames = { "#role": "role" };
    const expressionAttributeValues = { ":role": newRole || "user" };

    setExpressions.push("#cityID = :cityID");
    expressionAttributeNames["#cityID"] = "CityID";
    expressionAttributeValues[":cityID"] = finalCityId;

    // Add state to UsersTable
    setExpressions.push("#state = :state");
    expressionAttributeNames["#state"] = "State";
    expressionAttributeValues[":state"] = state;

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
    if (providedEmail && providedEmail !== "NA") {
      setExpressions.push("#EmailAddress = :email");
      expressionAttributeNames["#EmailAddress"] = "Email";
      expressionAttributeValues[":email"] = providedEmail;
    }
    if (phoneNumber) {
      setExpressions.push("#phoneNumber = :phoneNumber");
      expressionAttributeNames["#phoneNumber"] = "PhoneNumber";
      expressionAttributeValues[":phoneNumber"] = phoneNumber;
    }
    if (finalCollegeDetails?.CollegeID) {
      setExpressions.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = finalCollegeDetails;
    } else if (existingDynamoData.collegeDetails) {
      removeExpressions.push("#collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
    }

    let finalUpdateExpression = "SET " + setExpressions.join(", ");
    if (removeExpressions.length > 0) {
      finalUpdateExpression += " REMOVE " + removeExpressions.join(", ");
    }

    console.log("Final Update Expression:", finalUpdateExpression);
    console.log("Expression Attribute Names:", expressionAttributeNames);

    // Update DynamoDB UsersTable
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
        cityId: finalCityId,
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

async function ensureCityExists(cityName, cityId, state) {
  try {
    // Check if cityId exists in City table
    const response = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: CITY_TABLE,
        Key: marshall({ CityID: cityId }),
      })
    );

    if (!response.Item) {
      // City doesn’t exist, insert it with state
      await dynamoDBClient.send(
        new PutCommand({
          TableName: CITY_TABLE,
          Item: {
            CityID: cityId, // GeoNames cityId
            CityName: cityName,
            State: state, // Include state
            CreatedAt: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(CityID)", // Avoid overwrite
        })
      );
      console.log(
        `Inserted new city: ${cityName}, State: ${state} with CityID: ${cityId}`
      );
    } else {
      const existingCity = unmarshall(response.Item);
      if (existingCity.CityName !== cityName || existingCity.State !== state) {
        throw new Error(
          `CityID ${cityId} already exists with different name or state: ${existingCity.CityName}, ${existingCity.State}`
        );
      }
      console.log(
        `City ${cityName}, State: ${state} already exists with CityID: ${cityId}`
      );
    }

    return cityId;
  } catch (error) {
    console.error("Error ensuring city exists:", error);
    throw error;
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
    throw error;
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
