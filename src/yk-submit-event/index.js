export const submitEvent = async (eventData) => {
  try {
    console.log("Input event:", JSON.stringify(eventData));

    const { username, eventImages, ...eventDetails } = eventData;
    const REGION = process.env.AWS_REGION;
    const TABLE = process.env.EVENTS_TABLE;
    const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

    // Validate and prepare event images
    const imageUrls = [];
    const imageKeys = [];
    const maxImages = 3;

    // Upload images to S3 if provided
    for (let i = 0; i < Math.min(eventImages.length, maxImages); i++) {
      const image = eventImages[i];
      const imageKey = `event-images/${username}_${Date.now()}_${i + 1}`;

      // Generate the presigned URL for image upload
      const presignedUrl = await getSignedUrl(
        s3Client,
        new PutObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: imageKey,
          ContentType: image.type,
        }),
        { expiresIn: 300 }
      );

      // Store image URLs and keys for the response
      imageUrls.push(
        `https://${S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com/${imageKey}`
      );
      imageKeys.push(imageKey);
    }

    // Prepare event data for DynamoDB
    const eventPayload = {
      EventID: { S: username },
      EventName: { S: eventDetails.eventName || "" },
      EventDate: { S: eventDetails.eventDate || "" },
      EventLocation: { S: eventDetails.eventLocation || "" },
      EventDetails: { S: eventDetails.eventDetails || "" },
      EventImages: { L: imageUrls.map((url) => ({ S: url })) },
      CityID: { S: eventDetails.CityID || "" },
      CategoryID: { S: eventDetails.CategoryID || "" },
      EventType: { S: eventDetails.eventType || "" },
      CollegeID: { S: eventDetails.CollegeID || "" },
      Tags: { S: eventDetails.tags || "" },
      EventHighLight: { S: eventDetails.eventHighLight || "" },
      Price: { N: eventDetails.price || "" },
      Seats: { N: eventDetails.seats || "" },
      ReservedSeats: { N: eventDetails.reservedSeats || "" },
      AudienceBenefits: { N: eventDetails.audienceBenefits || "" },
      AdditionalInfo: { N: eventDetails.additionalInfo || "" },
    };

    // Check if the event already exists
    const getParams = {
      TableName: TABLE,
      Key: {
        EventID: { S: username },
      },
    };

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );

    // If event exists, update it; otherwise, insert a new record
    if (existingRecord.Item) {
      const updateParams = {
        TableName: TABLE,
        Key: { EventID: { S: username } },
        UpdateExpression: `
          SET EventName = :eventName,
              EventDate = :eventDate,
              EventLocation = :eventLocation,
              EventDetails = :eventDetails,
              EventImages = :eventImages,
              CityID = :cityID,
              CategoryID = :categoryID,
              EventType = :eventType,
              CollegeID = :collegeID,
              Tags = :tags,
              EventHighLight = :eventHighLight,
              Price = :price,
              Seats = :seats,
              ReservedSeats = :reservedSeats,
              AudienceBenefits = :audienceBenefits,
              AdditionalInfo = :additionalInfo,
              UpdatedAt = :updatedAt
        `,
        ExpressionAttributeValues: {
          ":eventName": { S: eventDetails.eventName },
          ":eventDate": { S: eventDetails.eventDate },
          ":eventLocation": { S: eventDetails.eventLocation },
          ":eventDetails": { S: eventDetails.eventDetails },
          ":eventImages": { L: imageUrls.map((url) => ({ S: url })) },
          ":cityID": { S: eventDetails.CityID },
          ":categoryID": { S: eventDetails.CategoryID },
          ":eventType": { S: eventDetails.eventType },
          ":collegeID": { S: eventDetails.CollegeID },
          ":tags": { S: eventDetails.tags },
          ":eventHighLight": { S: eventDetails.eventHighLight },
          ":price": { N: eventDetails.price.toString() },
          ":seats": { N: eventDetails.seats.toString() },
          ":reservedSeats": { N: eventDetails.reservedSeats.toString() },
          ":audienceBenefits": { N: eventDetails.audienceBenefits.toString() },
          ":additionalInfo": { N: eventDetails.additionalInfo.toString() },
          ":updatedAt": { S: new Date().toISOString() },
        },
      };
      await dynamoDBClient.send(new UpdateItemCommand(updateParams));
      console.log("Event updated successfully.");
    } else {
      const insertParams = {
        TableName: TABLE,
        Item: {
          EventID: { S: username },
          EventName: { S: eventDetails.eventName },
          EventDate: { S: eventDetails.eventDate },
          EventLocation: { S: eventDetails.eventLocation },
          EventDetails: { S: eventDetails.eventDetails },
          EventImages: { L: imageUrls.map((url) => ({ S: url })) },
          CityID: { S: eventDetails.CityID },
          CategoryID: { S: eventDetails.CategoryID },
          EventType: { S: eventDetails.eventType },
          CollegeID: { S: eventDetails.CollegeID },
          Tags: { S: eventDetails.tags },
          EventHighLight: { S: eventDetails.eventHighLight },
          Price: { N: eventDetails.price.toString() },
          Seats: { N: eventDetails.seats.toString() },
          ReservedSeats: { N: eventDetails.reservedSeats.toString() },
          AudienceBenefits: { N: eventDetails.audienceBenefits.toString() },
          AdditionalInfo: { N: eventDetails.additionalInfo.toString() },
          CreatedAt: { S: new Date().toISOString() },
        },
      };
      await dynamoDBClient.send(new PutItemCommand(insertParams));
      console.log("Event inserted successfully.");
    }

    // Return success response with the presigned URLs
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: "Event submission completed successfully.",
        presignedUrls: imageUrls, // return the presigned URLs for the images
      }),
    };
  } catch (error) {
    console.error("Error processing event:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};
