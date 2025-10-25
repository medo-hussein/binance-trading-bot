# Binance Trading Bot 🤖

A sophisticated automated cryptocurrency trading bot with real-time market data processing and multiple trading strategies.

## 🚀 Features

- **Real-time Trading** - WebSocket integration with Binance
- **Multiple Strategies** - Grid, DCA Buy, DCA Sell
- **Responsive Dashboard** - Single Page Application (SPA)
- **Advanced Security** - API key encryption & input sanitization
- **Persistent Storage** - 24/7 operation with data recovery

## 🛠 Technologies

- **Backend:** Node.js, Express.js, WebSocket
- **Frontend:** HTML5, CSS3, JavaScript, Chart.js
- **API:** Binance REST & WebSocket API
- **Security:** Helmet, CORS, Rate Limiting



# Install dependencies:

bash
npm install
Configure environment:

bash
cp .env.example .env
# Edit .env with your Binance API keys
Start the application:

bash
npm run dev
📊 Trading Strategies
Grid Trading
Automated buy low, sell high

Configurable grid levels and spread

DCA (Dollar Cost Averaging)
DCA Buy: Accumulate assets at lower prices

DCA Sell: Distribute assets at higher prices

🔒 Security Features
API key encryption

Input sanitization

Rate limiting

CORS protection

Helmet security headers

📈 Live Features
Real-time price updates

Live order tracking

Portfolio management

Performance analytics
## ⚡ Quick Start

1. Clone the repository:
```bash
git clone https://github.com/medo-hussein/binance-trading-bot.git
