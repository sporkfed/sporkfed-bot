# Sporkfed

> A GitHub App built with [Probot](https://github.com/probot/probot) that A Probot app

## Setup

```sh
# Install dependencies
yarn install

# Run the bot
yarn start
```

## Docker

```sh
# 1. Build container
docker build -t sporkfed .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> sporkfed
```

## Contributing

If you have suggestions for how sporkfed could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2021 theochupp <tclchiam@gmail.com>
