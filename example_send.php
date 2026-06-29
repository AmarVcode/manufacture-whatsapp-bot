<?php
/**
 * Example PHP script to send WhatsApp messages via the Node.js bot
 */

// Replace this with your Render service URL or local URL
$botUrl = 'http://localhost:3001/send'; // For local testing
// $botUrl = 'https://your-render-service.onrender.com/send'; // For production on Render

// The message you want to send
$message = "Hello from PHP! 🚀\nThis is a test message sent from your PHP application.";

// Prepare the data
$data = [
    'message' => $message
];

// Initialize cURL
$ch = curl_init($botUrl);

// Set cURL options
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json'
]);

// Execute the request
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// Handle the response
if ($httpCode === 200) {
    $result = json_decode($response, true);
    if ($result['success']) {
        echo "Message sent successfully!\n";
    } else {
        echo "Failed to send message: " . $result['error'] . "\n";
    }
} else {
    echo "Error: HTTP $httpCode\nResponse: $response\n";
}
