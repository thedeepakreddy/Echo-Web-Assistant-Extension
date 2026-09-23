const os = require('os');
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  devtool: false,
  entry: {
    showcase: path.resolve(__dirname, 'avatar-showcase.tsx'),
    options: [path.resolve(__dirname, 'chrome-mock.ts'), path.resolve(__dirname, '../../src/popup/options.tsx')],
    sidepanel: [path.resolve(__dirname, 'chrome-mock.ts'), path.resolve(__dirname, '../../src/popup/sidepanel.tsx')],
    content: [path.resolve(__dirname, 'chrome-mock.ts'), path.resolve(__dirname, '../../src/content/index.tsx')],
  },
  module: {
    rules: [
      { test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ },
      { test: /\.css$/i, use: ['style-loader', 'css-loader'] },
    ],
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  optimization: { splitChunks: false, runtimeChunk: false },
  output: {
    clean: true,
    filename: '[name].js',
    path: path.join(os.tmpdir(), 'echo-docs-showcase'),
  },
  plugins: [new CopyPlugin({ patterns: [
    { from: path.resolve(__dirname, 'avatar-showcase.html'), to: 'index.html' },
    { from: path.resolve(__dirname, 'content-showcase.html'), to: 'content.html' },
    { from: path.resolve(__dirname, '../../src/popup/options.html'), to: 'options.html' },
    { from: path.resolve(__dirname, '../../src/popup/sidepanel.html'), to: 'sidepanel.html' },
    { from: path.resolve(__dirname, '../../src/content/speech.html'), to: 'speech.html' },
    { from: '*/*.webp', context: path.resolve(__dirname, '../../src/assets/characters'), to: 'characters/' },
  ] })],
};
