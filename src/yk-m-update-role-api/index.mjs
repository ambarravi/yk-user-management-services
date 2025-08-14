import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid"; // Add uuid package for UUID generation
import { validateCollegeNameAI } from "./validateCollegeNameAI.js";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr"; // Verify this matches your Cognito User Pool
const USERS_TABLE = "UsersTable";
const CITY_TABLE = "City";
const COLLEGE_TABLE = "College";
const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

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

    if (!userID || !city || !cityId) {
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

    let cognitoIdentifier = userID;
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

    // Step 2: Handle college details - Check or create CollegeID
    let finalCollegeDetails = collegeDetails;
    if (collegeId && Object.keys(collegeDetails).length === 0) {
      console.log(`Fetching details for collegeId: ${collegeId}`);
      finalCollegeDetails = (await fetchCollegeDetails(collegeId)) || {};
    } else if (!finalCollegeDetails.CollegeID && finalCollegeDetails.Name) {
      // CollegeID missing, check if college exists or create new
      const existingCollege = await getCollegeByNameAndCity(
        finalCollegeDetails.Name,
        finalCityId
      );
      if (existingCollege) {
        console.log(
          `Found existing college: ${JSON.stringify(existingCollege)}`
        );
        finalCollegeDetails = existingCollege;
      } else {
        const validationResult = await validateCollegeNameAI(
          finalCollegeDetails.Name
        );

        if (!validationResult.valid) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              error:
                "College/Institution name not recognized. Please re-enter the correct official name",
              reason: validationResult.reason,
            }),
          };
        }
        // Create new college with UUID
        const newCollegeId = uuidv4();
        finalCollegeDetails = {
          CollegeID: newCollegeId,
          Name: finalCollegeDetails.Name,
          CityID: finalCityId,
          City: city,
          CreatedAt: new Date().toISOString(),
        };
        await createCollege(finalCollegeDetails);
        console.log(
          `Created new college: ${JSON.stringify(finalCollegeDetails)}`
        );
      }
    }

    // Prepare Cognito updates
    let updatedAttributes = [];
    if (roleUpdateRequired) {
      updatedAttributes.push({ Name: "custom:role", Value: newRole });
    }
    updatedAttributes.push({
      Name: "custom:City_Geo_Code",
      Value: finalCityId,
    });
    updatedAttributes.push({ Name: "custom:City", Value: city });
    updatedAttributes.push({ Name: "custom:State", Value: state });
    if (phoneNumber) {
      let updatedPhone;
      if (phoneNumber && !phoneNumber.startsWith("+91")) {
        updatedPhone = "+91" + phoneNumber.replace(/^0+/, "").slice(-10);
      }
      updatedAttributes.push({ Name: "phone_number", Value: updatedPhone });
    }
    if (name) {
      updatedAttributes.push({ Name: "given_name", Value: name });
    }
    if (lastName) {
      updatedAttributes.push({ Name: "family_name", Value: lastName });
    }
    // if (finalCollegeDetails.CollegeID) {
    //   updatedAttributes.push({
    //     Name: "custom:College_ID",
    //     Value: finalCollegeDetails.CollegeID,
    //   }); // Changed to custom:College_ID
    // } else if (existingCognitoAttributes["custom:College_ID"]) {
    //   updatedAttributes.push({ Name: "custom:College_ID", Value: "" });
    // }

    // Update Cognito if we have an identifier and attributes to update
    if (cognitoIdentifier && updatedAttributes.length > 0) {
      console.log("Updating Cognito attributes for:", cognitoIdentifier);
      console.log("Attributes to update:", updatedAttributes);
      await cognitoClient.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: cognitoIdentifier,
          UserAttributes: updatedAttributes,
        })
      );
      console.log("Cognito attributes updated successfully");
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

    setExpressions.push("#city = :city");
    expressionAttributeNames["#city"] = "City";
    expressionAttributeValues[":city"] = city;

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
    const response = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: CITY_TABLE,
        Key: marshall({ CityID: cityId }),
      })
    );

    if (!response.Item) {
      await dynamoDBClient.send(
        new PutCommand({
          TableName: CITY_TABLE,
          Item: {
            CityID: cityId,
            CityName: cityName,
            State: state,
            CreatedAt: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(CityID)",
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

async function getCollegeByNameAndCity(collegeName, cityId) {
  try {
    const response = await dynamoDBClient.send(
      new QueryCommand({
        TableName: COLLEGE_TABLE,
        IndexName: "Name-CityID-index",
        KeyConditionExpression: "#name = :name and #cityId = :cityId",
        ExpressionAttributeNames: { "#name": "Name", "#cityId": "CityID" },
        ExpressionAttributeValues: {
          ":name": collegeName,
          ":cityId": cityId,
        },
      })
    );
    return response.Items.length > 0 ? unmarshall(response.Items[0]) : null;
  } catch (error) {
    console.error("Error querying college:", error);
    return null;
  }
}

async function createCollege(collegeDetails) {
  try {
    await dynamoDBClient.send(
      new PutCommand({
        TableName: COLLEGE_TABLE,
        Item: collegeDetails,
        ConditionExpression: "attribute_not_exists(CollegeID)",
      })
    );
  } catch (error) {
    console.error("Error creating college:", error);
    throw error;
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
