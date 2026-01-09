# 🏦 Kauri - Smart Financial Management API

Kauri is a comprehensive, production-ready REST API for personal finance management. It leverages AI to provide deep financial insights, automate budgeting, and scan physical receipts, creating a seamless financial ecosystem.

---

## 🌟 Core Features & Functionalities

### 1. 🛡️ Advanced Authentication System
- **Secure Access**: JWT-based authentication with high-entropy secrets.
- **Session Management**: Dual-token system (Access & Refresh) for secure long-lived sessions.
- **Protection**: Brute-force protection via rate limiting and secure headers (Helmet).
- **Device Sync**: Firebase Cloud Messaging (FCM) token management for cross-device notifications.

### 2. 💰 Intelligent Transaction Management
- **Transaction Tracking**: Full CRUD for income and expenses with tagging and categories.
- **Automation**: Identification of recurring transactions (subscriptions, utility bills).
- **History**: Paginated access to historical data with powerful filtering (date ranges, types, categories).

### 3. 📊 Smart Budgeting (Auto-Init)
- **Period-based Budgets**: Monthly and yearly budget planning.
- **Category Allocation**: Granular control over spending limits per category.
- **Auto-Month**: Automated transition to the next month, maintaining your financial categories from the previous month.

### 4. 🎯 Results-Driven Saving Goals
- **Goal Setting**: Track savings for specific projects (Emergency fund, Vacation, etc.).
- **Smart Strategies**: Support for "50-30-20", "Pay-Yourself-First", and custom strategies.
- **Progress Tracking**: Real-time progress visualization and contribution history.

### 5. 🤖 AI Financial Coach (Gemini 2.0)
- **Real-time Advice**: Ask specific questions about your spending or financial health.
- **Context-Aware**: The coach analyzes your recent transactions to provide personalized tips.
- **Tone Choice**: Choose between "encouraging", "firm", or "balanced" coaching styles.

### 6. 📸 AI OCR Receipt Scanning
- **Instant Entry**: Upload a photo of a receipt and the AI automatically extracts the merchant, amount, category, and date.
- **Accuracy**: Powered by Gemini 2.0 Flash for high-precision text extraction.

### 7. 🏆 Gamification & Challenges
- **Community Challenges**: Join pre-defined challenges (e.g., "7 Days No Delivery").
- **Rewards**: Earn points and track progress on a personal leaderboard.

### 8. 💳 Integrated Payments
- **Multi-Gateway**: Support for Stripe (International) and NotchPay (local/Cameroonian agents).
- **Premium Upgrades**: Automated management of premium subscriptions.

---

## 🛣️ Detailed API Endpoint Guide

### 🔐 Authentication (`/api/v1/auth`)
- `POST /register`: Create a new account.
- `POST /login`: Generate JWT tokens.
- `POST /refresh`: Refresh an expired access token.
- `POST /logout`: Invalidate session.
- `POST /fcm-token`: Update push notification token.

### 💸 Transactions (`/api/v1/transactions`)
- `GET /`: List all transactions with advanced filtering.
- `POST /`: Create a new manual entry.
- `GET /:id`: View transaction details.
- `PUT /:id`: Edit an existing entry.
- `DELETE /:id`: Remove a transaction.

### 📅 Budgets (`/api/v1/budgets`)
- `GET /`: View all historical budgets.
- `POST /`: Create a new budget plan.
- `GET /current`: Get the currently active budget status.
- `PUT /:id`: Update allocations for categories.

### 🚩 Saving Goals (`/api/v1/goals`)
- `GET /`: List all goals.
- `POST /`: Initialize a new saving goal.
- `GET /:id`: View goal progress.
- `POST /:id/contribute`: Log a new contribution to the goal.

### 🦾 AI Services
- `POST /api/v1/coach/ask`: Interactive financial coaching session.
- `GET /api/v1/coach/history`: View past AI chat history.
- `GET /api/v1/insights/spending`: AI-generated spending analysis report.

### 📊 Reports (`/api/v1/reports`)
- `GET /dashboard`: High-level summary (Balance, Total Spent, Goal Progress).
- `GET /analysis`: Categorized spending breakdown with percentages.
- `GET /trends`: Monthly spending evolution.
- `GET /export/csv`: Export all financial data to CSV.

### 📷 Uploads & OCR
- `POST /api/v1/upload/receipt`: Process image files to auto-extract data.
- `POST /api/v1/upload/avatar`: Update user profile picture.

---

## 🛠️ Infrastructure & Setup

### Docker Quickstart (Recommended)
You can launch the entire stack (API + MongoDB + Redis) in one command:
```bash
docker-compose up --build
```

### Manual Installation
1. Install dependencies: `npm install`
2. Configure `.env` based on `.env.example`
3. Build: `npm run build`
4. Run: `npm start`

---

## 🛡️ Security Measures
- **Helmet**: Protection against common web vulnerabilities.
- **Rate-Limiting**: 100 requests per 15 minutes per IP.
- **Joi Validation**: Strict typed validation on all request bodies.
- **Bcrypt**: Password hashing with salt factor 12.

---

## 📄 License
This project is licensed under the **MIT License**. See the `LICENSE` file for details.
Designed and Developed by **Boris Gauty**.
