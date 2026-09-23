const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  devtool: false,
  entry: {
    background: './src/background/index.ts',
    content: './src/content/index.tsx',
    options: './src/popup/options.tsx',
    sidepanel: './src/popup/sidepanel.tsx',
    speech: './src/content/speech.ts',
    approval: './src/content/approval.ts'
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      "node:fs": false,
      "node:path": false,
      "node:os": false,
      "node:crypto": false,
      "node:stream": false,
      "node:process": false
    },
    fallback: {
      "fs": false,
      "path": false,
      "os": false,
      "crypto": false,
      "stream": false,
      "process": false
    }
  },
  optimization: {
    // CRITICAL: Disable all code splitting. Chrome extensions cannot dynamically
    // load chunks from content scripts unless they are in web_accessible_resources.
    // The simplest and most reliable fix is to bundle everything into single files.
    splitChunks: false,
    runtimeChunk: false,
  },
  output: {
    clean: true,
    filename: '[name].js',
    chunkFilename: 'async.[contenthash:8].js',
    path: path.resolve(__dirname, 'dist'),
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'src/popup/options.html', to: '.' },
        { from: 'src/popup/sidepanel.html', to: '.' },
        { from: 'src/content/speech.html', to: '.' },
        { from: 'src/content/approval.html', to: '.' },
        { from: '*/*.webp', context: 'src/assets/characters', to: 'characters/' }
      ],
    }),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
  ],
};
