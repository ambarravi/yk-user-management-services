import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";

const REGION = process.env.AWS_REGION;
const USER_POOL_ID = "eu-west-1_hgUDdjyRr";
const USERS_TABLE = "UsersTable";
const CITY_TABLE = "City";
const COLLEGE_TABLE = "College";
const dynamoDBClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

// Main handler
export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  try {
    // Validate input
    const userData = validateInput(event);

    // Fetch existing data
    const existingDynamoData = await getDynamoUser(userData.userID);
    const cognitoIdentifier = getCognitoIdentifier(
      userData,
      existingDynamoData
    );
    const existingCognitoAttributes = cognitoIdentifier
      ? await getCognitoAttributes(cognitoIdentifier)
      : {};

    // Process city and college
    const finalCityId = await ensureCityExists(
      userData.city,
      userData.cityId,
      userData.state
    );
    const finalCollegeDetails = await processCollegeDetails(
      userData.collegeDetails || {},
      userData.collegeId,
      finalCityId,
      userData.city,
      userData.userID
    );

    // Update Cognito and DynamoDB
    await updateCognitoAttributes(
      cognitoIdentifier,
      userData,
      existingCognitoAttributes
    );
    const updatedUser = await updateDynamoUser(
      userData.userID,
      userData,
      finalCityId,
      finalCollegeDetails,
      existingDynamoData
    );

    // Return standardized response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Role and attributes updated successfully",
        cityId: finalCityId,
        collegeDetails: finalCollegeDetails,
        currentRole: updatedUser.currentRole || "user",
        followingCount: existingDynamoData.FollowingCount ?? 0,
        eventsAttended: existingDynamoData.eventsAttended ?? 0,
        fname: userData.name || existingDynamoData.FirstName || "N/A",
        lname: userData.lastName || existingDynamoData.LastName || "N/A",
        phoneNumber: userData.phoneNumber || existingDynamoData.PhoneNumber,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
        error: error.message,
      }),
    };
  }
};

// Input validation
const validateInput = (event) => {
  const requiredFields = ["userID", "city", "cityId"];
  const missingFields = requiredFields.filter((field) => !event[field]);
  if (missingFields.length > 0) {
    const error = new Error(
      `Missing required fields: ${missingFields.join(", ")}`
    );
    error.statusCode = 400;
    throw error;
  }
  return {
    userID: event.userID,
    userName: event.userName,
    tempRole: event.tempRole || "user",
    currentRole: event.currentRole,
    city: event.city,
    cityId: event.cityId,
    state: event.state || "",
    collegeDetails: event.collegeDetails || {},
    collegeId: event.collegeId,
    name: event.name,
    email: event.email,
    lastName: event.lastName,
    phoneNumber: event.phoneNumber,
  };
};

// Determine Cognito identifier
const getCognitoIdentifier = (userData, existingDynamoData) => {
  const identifier =
    userData.userID ||
    existingDynamoData.Email ||
    userData.email ||
    userData.userName;
  return identifier && identifier !== "NA" && identifier !== "Unknown"
    ? identifier
    : null;
};

// Fetch Cognito attributes
async function getCognitoAttributes(identifier) {
  try {
    console.log("Fetching Cognito attributes for:", identifier);
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
    console.warn("Failed to fetch Cognito attributes:", error);
    return {};
  }
}

// Fetch DynamoDB user data
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

// Ensure city exists in City table
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
        new PutItemCommand({
          TableName: CITY_TABLE,
          Item: marshall({
            CityID: cityId,
            CityName: cityName,
            State: state,
            CreatedAt: new Date().toISOString(),
          }),
          ConditionExpression: "attribute_not_exists(CityID)",
        })
      );
      console.log(
        `Inserted new city: ${cityName}, State: ${state}, CityID: ${cityId}`
      );
    } else {
      const existingCity = unmarshall(response.Item);
      if (existingCity.CityName !== cityName || existingCity.State !== state) {
        const error = new Error(
          `CityID ${cityId} already exists with different name or state: ${existingCity.CityName}, ${existingCity.State}`
        );
        error.statusCode = 400;
        throw error;
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

// Process college details
async function processCollegeDetails(
  collegeDetails,
  collegeId,
  cityId,
  city,
  userID
) {
  try {
    if (collegeDetails?.name && !collegeDetails.Name) {
      collegeDetails.Name = collegeDetails.name;
      delete collegeDetails.name; // optional cleanup
    }

    if (!collegeId && Object.keys(collegeDetails).length === 0) {
      console.log(
        "No college details or collegeId provided, skipping college processing"
      );
      return {};
    }

    if (collegeId && Object.keys(collegeDetails).length === 0) {
      console.log(`Fetching details for collegeId: ${collegeId}`);
      return (await fetchCollegeDetails(collegeId)) || {};
    }

    if (
      !collegeDetails.CollegeID &&
      collegeDetails.Name &&
      collegeDetails.source === "ai_suggestions"
    ) {
      const existingCollege = await getCollegeByNameAndCity(
        collegeDetails.Name,
        cityId
      );
      if (existingCollege) {
        console.log(
          `Found existing college: ${JSON.stringify(existingCollege)}`
        );
        return existingCollege;
      }

      // Create new college
      const newCollegeId = uuidv4();
      const nameParts = collegeDetails.Name.split(",");
      const collegeName = nameParts[0] ? nameParts[0].trim() : "";
      const collegeArea = nameParts[1] ? nameParts[1].trim() : "";
      const collegeShortform = nameParts[2] ? nameParts[2].trim() : "";

      const newCollegeDetails = {
        CollegeID: newCollegeId,
        Name: collegeName,
        NameLower: collegeName.toLowerCase(),
        Shortform: collegeShortform || "",
        ShortformLower: (collegeShortform || "").toLowerCase(),
        Area: collegeArea || "",
        AreaLower: (collegeArea || "").toLowerCase(),
        CityID: cityId,
        City: city.toLowerCase(),
        Verified: false,
        CreatedAt: new Date().toISOString(),
        CreatedBy: userID,
      };

      await createCollege(newCollegeDetails);
      console.log(`Created new college: ${JSON.stringify(newCollegeDetails)}`);
      return newCollegeDetails;
    }

    return collegeDetails;
  } catch (error) {
    console.error("Error processing college details:", error);
    throw error;
  }
}

// Fetch college details
async function fetchCollegeDetails(collegeId) {
  try {
    const response = await dynamoDBClient.send(
      new GetItemCommand({
        TableName: COLLEGE_TABLE,
        Key: marshall({ CollegeID: collegeId }),
      })
    );
    return response.Item ? unmarshall(response.Item) : {};
  } catch (error) {
    console.error("Error fetching college details:", error);
    return {};
  }
}

// Query college by name and city
async function getCollegeByNameAndCity(collegeName, cityId) {
  try {
    if (
      !collegeName ||
      typeof collegeName !== "string" ||
      !collegeName.trim()
    ) {
      console.error(`Invalid collegeName: ${collegeName}`);
      return null;
    }
    if (!cityId || typeof cityId !== "string" || !cityId.trim()) {
      console.error(`Invalid cityId: ${cityId}`);
      return null;
    }

    console.log(`Querying college: ${collegeName}, cityId: ${cityId}`);
    const response = await dynamoDBClient.send(
      new QueryCommand({
        TableName: COLLEGE_TABLE,
        IndexName: "Name-CityID-index",
        KeyConditionExpression: "#name = :name and #cityId = :cityId",
        ExpressionAttributeNames: {
          "#name": "Name",
          "#cityId": "CityID",
        },
        ExpressionAttributeValues: marshall({
          ":name": collegeName.trim(),
          ":cityId": cityId.trim(),
        }),
      })
    );

    return response.Items && response.Items.length > 0
      ? unmarshall(response.Items[0])
      : null;
  } catch (error) {
    console.error("Error querying college:", error);
    return null;
  }
}

// Create new college
async function createCollege(collegeDetails) {
  try {
    await dynamoDBClient.send(
      new PutItemCommand({
        TableName: COLLEGE_TABLE,
        Item: marshall(collegeDetails),
        ConditionExpression: "attribute_not_exists(CollegeID)",
      })
    );
  } catch (error) {
    console.error("Error creating college:", error);
    throw error;
  }
}

// Update Cognito attributes
async function updateCognitoAttributes(
  identifier,
  userData,
  existingAttributes
) {
  if (!identifier) {
    console.warn("No Cognito identifier provided, skipping Cognito update");
    return;
  }

  const attributes = [];
  if (
    userData.tempRole &&
    !existingAttributes["custom:role"]
      ?.toLowerCase()
      .includes(userData.tempRole.toLowerCase())
  ) {
    attributes.push({
      Name: "custom:role",
      Value: existingAttributes["custom:role"]
        ? `${existingAttributes[
            "custom:role"
          ].toLowerCase()},${userData.tempRole.toLowerCase()}`
        : userData.tempRole.toLowerCase(),
    });
  }
  if (userData.cityId) {
    attributes.push({ Name: "custom:City_Geo_Code", Value: userData.cityId });
  }
  if (userData.city) {
    attributes.push({ Name: "custom:City", Value: userData.city });
  }
  if (userData.state) {
    attributes.push({ Name: "custom:State", Value: userData.state });
  }
  if (userData.phoneNumber) {
    const updatedPhone = userData.phoneNumber.startsWith("+91")
      ? userData.phoneNumber
      : "+91" + userData.phoneNumber.replace(/^0+/, "").slice(-10);
    attributes.push({ Name: "phone_number", Value: updatedPhone });
  }
  if (userData.name) {
    attributes.push({ Name: "given_name", Value: userData.name });
  }
  if (userData.lastName) {
    attributes.push({ Name: "family_name", Value: userData.lastName });
  }

  if (attributes.length > 0) {
    console.log("Updating Cognito attributes for:", identifier, attributes);
    await cognitoClient.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: identifier,
        UserAttributes: attributes,
      })
    );
    console.log("Cognito attributes updated successfully");
  } else {
    console.warn("No Cognito attributes to update");
  }
}

// Update DynamoDB user
async function updateDynamoUser(
  userID,
  userData,
  cityId,
  collegeDetails,
  existingDynamoData
) {
  try {
    const setExpressions = [];
    const removeExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    // Role
    const newRole = userData.tempRole
      ? userData.currentRole
        ? `${userData.currentRole.toLowerCase()},${userData.tempRole.toLowerCase()}`
        : userData.tempRole.toLowerCase()
      : userData.currentRole || "user";
    setExpressions.push("#role = :role");
    expressionAttributeNames["#role"] = "role";
    expressionAttributeValues[":role"] = { S: newRole };

    // City
    setExpressions.push("#cityID = :cityID");
    expressionAttributeNames["#cityID"] = "CityID";
    expressionAttributeValues[":cityID"] = { S: cityId };

    setExpressions.push("#city = :city");
    expressionAttributeNames["#city"] = "City";
    expressionAttributeValues[":city"] = { S: userData.city };

    setExpressions.push("#state = :state");
    expressionAttributeNames["#state"] = "State";
    expressionAttributeValues[":state"] = { S: userData.state || "" };

    // Other fields
    if (userData.name) {
      setExpressions.push("#name = :FirstName");
      expressionAttributeNames["#name"] = "FirstName";
      expressionAttributeValues[":FirstName"] = { S: userData.name };
    }
    if (userData.lastName) {
      setExpressions.push("#lastName = :LastName");
      expressionAttributeNames["#lastName"] = "LastName";
      expressionAttributeValues[":LastName"] = { S: userData.lastName };
    }
    if (userData.email && userData.email !== "NA") {
      setExpressions.push("#EmailAddress = :email");
      expressionAttributeNames["#EmailAddress"] = "Email";
      expressionAttributeValues[":email"] = { S: userData.email };
    }
    if (userData.phoneNumber) {
      setExpressions.push("#phoneNumber = :phoneNumber");
      expressionAttributeNames["#phoneNumber"] = "PhoneNumber";
      expressionAttributeValues[":phoneNumber"] = { S: userData.phoneNumber };
    }
    if (collegeDetails?.CollegeID) {
      setExpressions.push("#collegeDetails = :collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
      expressionAttributeValues[":collegeDetails"] = {
        M: marshall(collegeDetails),
      };
    } else if (existingDynamoData.collegeDetails) {
      removeExpressions.push("#collegeDetails");
      expressionAttributeNames["#collegeDetails"] = "collegeDetails";
    }

    let updateExpression = "SET " + setExpressions.join(", ");
    if (removeExpressions.length > 0) {
      updateExpression += " REMOVE " + removeExpressions.join(", ");
    }

    console.log("Updating DynamoDB with expression:", updateExpression);
    await dynamoDBClient.send(
      new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: marshall({ UserID: userID }),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    return { currentRole: newRole };
  } catch (error) {
    console.error("Error updating DynamoDB user:", error);
    throw error;
  }
}
