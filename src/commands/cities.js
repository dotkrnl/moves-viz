'use strict';

const clustering = require('density-clustering');
const distance = require('fast-haversine');
const utils = require('../utils');
const resources = require('../resources');
const request = require('sync-request');
const _ = require('lodash');

exports.command = 'cities <input> <output>';
exports.desc = 'Generate small multiple city maps';
exports.builder = function (yargs) {

  yargs.describe('limit', 'Limit the number of cities displayed')
    .number('limit')
    .default('limit', 12);

  yargs.describe('activity', 'Filter movements to specified activity');

  yargs.describe('filter', 'Only render cities containing the given string');

  yargs.describe('min-points', '(advanced) Minimum number of points for clustering')
    .number('min-points')
    .default('min-points', 4);

  yargs.describe('cluster-epsilon', '(advanced) Tuning parameter for clustering, in meters')
    .number('cluster-epsilon')
    .default('cluster-epsilon', 12 * 1000);
  
};

exports.handler = function (options) {

  let segments = utils.loadStoryline(options.input, options);
  if (options.activity)
    segments = _.filter(segments, ['activity', options.activity]);

  const controlPoints = clusterLocations(segments, options);
  let clusters = _.chain(controlPoints)
    .sortBy(points => -points.length)
    .map(points => ({
      label: lookupLabel(points),
      controlPoints: points
    }))
    .value();

  if (options.filter)
    clusters = _.filter(clusters, c => {
      return (c.label || '').toLowerCase().indexOf(options.filter.toLowerCase()) > -1;
    });

  clusters = _.take(clusters, options.limit);

  const context = utils.createD3n(options);

  _.each(clusters, (cluster, index, clusters) => {
    const square = computeSquareDimensions(index, clusters.length, options);
    drawMapAtSquare(context, square, cluster, segments, options);
  });
 
  utils.writeOutput(context.d3n, options.output, options);
};

function clusterLocations(segments, options) {

  const moves = _.filter(segments, ['type', 'move']);
  const dataset = _.chain(moves)
    .flatMap(m => [_.first(m.trackPoints), _.last(m.trackPoints)])
    .filter()
    .map(m => _.pick(m, ['lat', 'lon']))
    .uniqBy(m => _.values(m).join(','))
    .value();

  const dbscan = new clustering.DBSCAN();
  const clusters = dbscan.run(dataset, options['cluster-epsilon'], options['min-points'], distance);

  return _.map(clusters, cluster => _.map(cluster, index => dataset[index]));
}

function computeSquareDimensions(index, count, options) {

  const area = options.height * options.width;
  const perSquareArea = area / count;
  const maxSquare = Math.sqrt(perSquareArea);

  const height = Math.floor(options.height / Math.ceil(options.height / maxSquare));
  const width =  Math.floor(options.width / Math.ceil(options.width / maxSquare));

  const size = Math.min(height, width);
  const across = Math.floor(options.width / size);

  const row = Math.floor(index / across);
  const column = index % across;

  return {
    row: row,
    column: column,
    x: column * size,
    y: row * size,
    size: size
  };
}

function drawMapAtSquare(context, square, cluster, segments, options) {

  const moves = _.filter(segments, ['type', 'move']);

  const projection = createProjection(context, cluster.controlPoints, square.size, square.size);
  const geopath = context.d3.geoPath()
    .projection(projection);

  const theme = resources.themes(options.theme);

  const backgroundColors = [_.first(theme.background_colors), _.last(theme.background_colors)];
  const backgroundColor = backgroundColors[(square.row + square.column) % backgroundColors.length];

  const activityColors = context.d3.scaleOrdinal(theme.forground_colors)
    .domain(_.chain(moves).map('activity').uniq().sort().value());

  context.svg.append('rect')
    .attr('x', square.x)
    .attr('y', square.y)
    .attr('height', square.size)
    .attr('width', square.size)
    .attr('fill', backgroundColor);

  const pointToCoord = point => [point.lon, point.lat];
  _.each(moves, move => {

    context.svg.append('path')
      .datum({type: 'LineString', coordinates: _.map(move.trackPoints, pointToCoord) })
      .attr('class', `move ${move.activity}`)
      .attr('fill', 'none')
      .attr('opacity', 0.2)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .attr('stroke', activityColors(move.activity))
      .attr('stroke-width', theme.stroke_width || 1)
      .attr('transform', `translate(${square.x},${square.y})`)
      .attr('d', geopath);
  });

  const fontSize = Math.min(square.size * 0.05, 16);
  context.svg.append('text')
    .attr('text-anchor', 'start')
    .attr('font-family', 'sans-serif')
    .attr('stroke', 'none')
    .attr('fill', _.last(theme.forground_colors))
    .attr('font-size', fontSize)
    .attr('x', square.x + fontSize * 0.5)
    .attr('y', square.y + square.size - fontSize * 0.5)
    .text(cluster.label);

}

function createProjection(context, controlPoints, height, width) {

  const lats = _.map(controlPoints, 'lat');
  const lons = _.map(controlPoints, 'lon');

  const topLeft = [_.min(lons), _.max(lats)];
  const bottomRight = [_.max(lons), _.min(lats)];

  const fit = { type: 'LineString', coordinates: [topLeft, bottomRight] };
  const extent = [[width * 0.2, height * 0.2], [width * 0.8, height * 0.8]];

  return context.d3.geoMercator()
    .fitExtent(extent, fit)
    .clipExtent([[0, 0], [width, height]]);
}

function lookupLabel(controlPoints) {

  //just use euclidean geo since all points local, no worries about curve of earth
  const lats = _.map(controlPoints, 'lat');
  const lons = _.map(controlPoints, 'lon');
  const avg = points => _.reduce(points, (sum, l) => sum + l, 0) / points.length;
  const centroid = [avg(lats), avg(lons)];

  const response = request('GET', `http://maps.googleapis.com/maps/api/geocode/json?latlng=${centroid.join(',')}`).body.toString();
  const responseJson = JSON.parse(response);
  if (responseJson.status === 'OK') {
  
    const components = _.flatMap(responseJson.results, 'address_components');

    const typeFilter = (type) => (component => _.includes(component.types, type));
    const firstByType = (components, type) => _.chain(components).filter(typeFilter(type)).first().value();

    let city = _.get(firstByType(components, 'locality'), 'long_name');
    let region = _.get(firstByType(components, 'administrative_area_level_1'), 'long_name');
    return _.filter([city, region]).join(', ');

  } else {
    return '';
  }
}
