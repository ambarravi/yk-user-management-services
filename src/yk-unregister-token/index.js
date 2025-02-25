const AWS = require("aws-sdk");
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  const { userId } = JSON.parse(event.body);

  const params = {
    TableName: "TiktoPushTokens",
    Key: { userId },
  };

  try {
    await dynamoDb.delete(params).promise();
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Token unregistered" }),
    };
  } catch (error) {
    console.error("Error unregistering token:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to unregister token" }),
    };
  }
};
