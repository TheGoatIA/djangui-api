# Kauri API Documentation

Welcome to the Kauri API documentation. This API powers the Kauri financial management application, providing features for transaction tracking, budgeting, saving goals, AI-powered coaching, and more.

## Base URL
`http://localhost:5000/api/v1` (Development)

## Authentication
Most endpoints require a Bearer Token in the `Authorization` header.

```http
Authorization: Bearer <your_access_token>
```

---

## 1. Authentication (`/auth`)

### Register
`POST /auth/register`
- **Body**: `email`, `password`, `firstName`, `lastName`
- **Response**: `201 Created` with user and tokens.

### Login
`POST /auth/login`
- **Body**: `email`, `password`
- **Response**: `200 OK` with user and tokens.

### Refresh Token
`POST /auth/refresh`
- **Body**: `refreshToken`
- **Response**: `200 OK` with new tokens.

### Google Login
`POST /auth/google`
- **Body**: `idToken` (from Firebase)
- **Response**: `200 OK` with user and tokens.

### Logout
`POST /auth/logout` (Protected)
- **Response**: `200 OK`.

---

## 2. Transactions (`/transactions`)

### List Transactions
`GET /transactions` (Protected)
- **Query Params**: `page`, `limit`, `type`, `category`, `startDate`, `endDate`
- **Response**: List of transactions.

### Create Transaction
`POST /transactions` (Protected)
- **Body**: `amount`, `type` (income/expense), `category`, `description`, `date`, `merchant?`, `location?`
- **Response**: `201 Created`.

### Get/Update/Delete Transaction
`GET/PUT/DELETE /transactions/:id` (Protected)

---

## 3. Budgets (`/budgets`)

### List Budgets
`GET /budgets` (Protected)

### Create Budget
`POST /budgets` (Protected)
- **Body**: `period` (monthly/yearly), `categories` (name, allocated)

### Get Current Budget
`GET /budgets/current` (Protected)

---

## 4. Saving Goals (`/goals`)

### List/Create Goals
`GET/POST /goals` (Protected)

### Contribute to Goal
`POST /goals/:id/contribute` (Protected)
- **Body**: `amount`, `note?`

---

## 5. Coach AI (`/coach`)

### Ask Coach
`POST /coach/ask` (Protected)
- **Body**: `question`
- **Response**: AI-generated financial advice.

### Chat History
`GET /coach/history` (Protected)

---

## 6. Reports & Analytics (`/reports`)

### Dashboard Summary
`GET /reports/dashboard` (Protected)
- **Response**: Summary of balance, monthly spending, and budget status.

### Spending Analysis
`GET /reports/analysis` (Protected)
- **Response**: Categorized spending and comparison.

### Savings Trends
`GET /reports/trends` (Protected)

### Export CSV
`GET /reports/export/csv` (Protected)

---

## 7. Payments (`/payments`)

### Stripe Checkout
`POST /payments/checkout/stripe` (Protected)
- **Body**: `plan` (premium)

### NotchPay Init
`POST /payments/init/notchpay` (Protected)
- **Body**: `amount`, `currency`

---

## 8. Upload & OCR (`/upload`)

### Scan Receipt
`POST /upload/receipt` (Protected)
- **Multipart**: `receipt` (file)
- **Response**: Extracted transaction data.

### Upload Avatar
`POST /upload/avatar` (Protected)
- **Multipart**: `avatar` (file)
