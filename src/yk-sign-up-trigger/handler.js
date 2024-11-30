// Lambda function to handle signup trigger

const AWS = require("aws-sdk");
const dynamoDB = new AWS.DynamoDB.DocumentClient();

const USERS_TABLE = "UsersTable"; // Replace with your table name

exports.handler = async (event) => {
  console.log("Event received from Cognito:", JSON.stringify(event, null, 2));

  try {
    const { sub: UserID, email, given_name: FirstName, family_name: LastName, phone_number: Mobile } = event.request.userAttributes;

    if (!UserID) {
      throw new Error("Missing UserID (sub) from Cognito attributes");
    }

    // Construct the item to update
    const updateParams = {
      TableName: USERS_TABLE,
      Key: { UserID },
      UpdateExpression: `
        SET #email = :email, 
            #firstName = :firstName, 
            #lastName = :lastName, 
            #mobile = :mobile, 
            #createdAt = :createdAt
      `,
      ExpressionAttributeNames: {
        "#email": "Email",
        "#firstName": "FirstName",
        "#lastName": "LastName",
        "#mobile": "Mobile",
        "#createdAt": "CreatedAt",
      },
      ExpressionAttributeValues: {
        ":email": email || "N/A",
        ":firstName": FirstName || "N/A",
        ":lastName": LastName || "N/A",
        ":mobile": Mobile || "N/A",
        ":createdAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    };

    console.log("Update parameters:", JSON.stringify(updateParams, null, 2));

    // Perform the update
    const result = await dynamoDB.update(updateParams).promise();
    console.log("DynamoDB update result:", JSON.stringify(result, null, 2));

    return event; // Return the original event for Cognito
  } catch (error) {
    console.error("Error updating DynamoDB:", error.message);
    throw new Error(`Post-confirmation trigger failed: ${error.message}`);
  }
};
