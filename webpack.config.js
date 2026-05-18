const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  entry: {
    'html-app-view': './src/html-app-view/index.ts',
    'sidepanel': './src/sidepanel/index.ts',
    'background': './src/background/index.ts',
    'content-script': './src/content-script/index.ts',
    'page-bridge': './src/content-script/page-bridge.ts',
    'webmcp-polyfill': './src/content-script/webmcp-polyfill.ts',
    'options': './src/options/index.ts',
    'mcp-app-sandbox': './src/sidepanel/mcp-app-sandbox.ts',
    'page-automation-runtime': './src/sidepanel/tab-tools/page-automation/runtime-entry.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.html$/,
        include: path.resolve(__dirname, 'src/sidepanel/templates'),
        type: 'asset/source',
      },
      {
        test: /\.scss$/,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader',
          {
            loader: 'sass-loader',
            options: {
              api: 'modern-compiler',
            },
          },
        ],
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new MiniCssExtractPlugin({ filename: '[name].css' }),
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'src/extension-pages/sidepanel.html', to: '.' },
        { from: 'src/extension-pages/options.html', to: '.' },
        { from: 'src/extension-pages/mcp-app-sandbox.html', to: '.' },
        { from: 'src/extension-pages/html-app-view.html', to: '.' },
        { from: 'icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
  ],
  devtool: 'cheap-module-source-map',
};
