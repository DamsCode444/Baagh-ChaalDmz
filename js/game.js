function addGameLog(message) {
    
    console.log(message);

    const logEntry = document.createElement("div");

    logEntry.textContent = message;

    gameLogDisplay.appendChild(logEntry);

    gameLogDisplay.scrollTop = gameLogDisplay.scrollHeight;
}
const gameLogDisplay = document.getElementById("game-log");
addGameLog("Baagh-Chaal game started!");

// =============================================================================================
// 1. GAME STATE
// =============================================================================================
const tigers = [0, 4, 20, 24];

const goats = [1, 2, 3, 5, 10, 15, 21, 22, 23, 9, 14, 19, 11, 13, 12, 6, 7, 17, 8];
// const goats = [];

const gameState = {
    tigers: tigers,

    goats: goats,

    goatsPlaced: goats.length,

    capturedGoats: goats.length,

    turn: "goat",

    phase: "placement",

    selectedPosition: null,

    selectedGoat: null,

    positionHistory: {},

    winner: null
};

console.log("Game State:", gameState);







// =============================================================================================
// 2. BOARD DATA
// =============================================================================================

const positions = [
    { id: 0, row: 0, col: 0 },
    { id: 1, row: 0, col: 1 },
    { id: 2, row: 0, col: 2 },
    { id: 3, row: 0, col: 3 },
    { id: 4, row: 0, col: 4 },

    { id: 5, row: 1, col: 0 },
    { id: 6, row: 1, col: 1 },
    { id: 7, row: 1, col: 2 },
    { id: 8, row: 1, col: 3 },
    { id: 9, row: 1, col: 4 },

    { id: 10, row: 2, col: 0 },
    { id: 11, row: 2, col: 1 },
    { id: 12, row: 2, col: 2 },
    { id: 13, row: 2, col: 3 },
    { id: 14, row: 2, col: 4 },

    { id: 15, row: 3, col: 0 },
    { id: 16, row: 3, col: 1 },
    { id: 17, row: 3, col: 2 },
    { id: 18, row: 3, col: 3 },
    { id: 19, row: 3, col: 4 },

    { id: 20, row: 4, col: 0 },
    { id: 21, row: 4, col: 1 },
    { id: 22, row: 4, col: 2 },
    { id: 23, row: 4, col: 3 },
    { id: 24, row: 4, col: 4 }
];

const connections = {
    0: [1, 5, 6],
    1: [0, 2, 6],
    2: [1, 3, 6, 7, 8],
    3: [2, 4, 8],
    4: [3, 8, 9],

    5: [0, 6, 10],
    6: [0, 1, 2, 5, 7, 10, 11, 12],
    7: [2, 6, 8, 12],
    8: [2, 3, 4, 7, 9, 12, 13, 14],
    9: [4, 8, 14],

    10: [5, 6, 11, 15, 16],
    11: [6, 10, 12, 16],
    12: [6, 7, 8, 11, 13, 16, 17, 18],
    13: [8, 12, 14, 18],
    14: [8, 9, 13, 18, 19],

    15: [10, 16, 20],
    16: [10, 11, 12, 15, 17, 20, 21, 22],
    17: [12, 16, 18, 22],
    18: [12, 13, 14, 17, 19, 22, 23, 24],
    19: [14, 18, 24],

    20: [15, 16, 21],
    21: [16, 20, 22],
    22: [16, 17, 18, 21, 23],
    23: [18, 22, 24],
    24: [18, 19, 23]
};








// =============================================================================================
// 3. DOM REFERENCES
// =============================================================================================

const board = document.getElementById("board")

const gameStatusDisplay = document.getElementById("game-status");

const phaseDisplay = document.getElementById("phase");
const goatsPlacedDisplay = document.getElementById("goats-placed");
const goatsOnBoardDisplay = document.getElementById("goats-on-board");
const goatsCapturedDisplay = document.getElementById("goats-captured");
const selectedTigerDisplay = document.getElementById("selected-tiger");
const selectedGoatDisplay = document.getElementById("selected-goat");

const newGameButton = document.getElementById("new-game");

const gameOverOverlay = document.getElementById("game-over-overlay");
const gameOverTitle = document.getElementById("game-over-title");
const gameOverMessage = document.getElementById("game-over-message");
const gameOverNewGame = document.getElementById("game-over-new-game");






 // =============================================================================================
// 4. DRAWING FUNCTIONS
// =============================================================================================

function drawPoints() {

    positions.forEach(position => {

        const point = document.createElement("div");

        point.classList.add("board-point");

        const coordinates =
            getPositionCoordinates(position);

        point.style.left = `${coordinates.x}%`;
        point.style.top = `${coordinates.y}%`;

        point.dataset.position = position.id;

        const positionNumber = document.createElement("span");

        positionNumber.classList.add("position-number");
        positionNumber.textContent = position.id;

        point.appendChild(positionNumber);

        board.appendChild(point);
    });
}




function drawLine(positionA, positionB) {

    const pointA = positions[positionA];
    const pointB = positions[positionB];

    const coordinatesA =
        getPositionCoordinates(pointA);

    const coordinatesB =
        getPositionCoordinates(pointB);

    const line =
        document.createElement("div");

    line.classList.add("board-line");

    line.style.left =
        `${coordinatesA.x}%`;

    line.style.top =
        `${coordinatesA.y}%`;

    const dx =
        coordinatesB.x - coordinatesA.x;

    const dy =
        coordinatesB.y - coordinatesA.y;

    const length =
        Math.sqrt(dx * dx + dy * dy);

    const angle =
        Math.atan2(dy, dx) * 180 / Math.PI;

    line.style.width =
        `${length}%`;

    line.style.transform =
        `rotate(${angle}deg)`;

    board.appendChild(line);
}




function drawConnections() {
    const drawnConnections = new Set();

    for (const [from, destinations] of Object.entries(connections)) {

        for (const to of destinations) {

            // Create a unique key for this connection
            const key = [Number(from), to]
                .sort((a, b) => a - b)
                .join("-");

            // Skip if we've already drawn this connection
            if (drawnConnections.has(key)) {
                continue;
            }

            drawLine(Number(from), to);

            drawnConnections.add(key);
        }
    }
}



function drawBoard() {
    board.innerHTML = ""

    drawPoints();
    drawConnections();
    drawTigers();
    drawGoats();
}



function drawTigers() {

    gameState.tigers.forEach(tigerPosition => {

        const tiger =
            document.createElement("div");

        tiger.classList.add("tiger");

        tiger.textContent = "🐯";

        const position =
            positions[tigerPosition];

        const coordinates =
            getPositionCoordinates(position);

        tiger.style.left =
            `${coordinates.x}%`;

        tiger.style.top =
            `${coordinates.y}%`;

        tiger.dataset.position = tigerPosition;

        board.appendChild(tiger);
    });
}


function drawGoats() {
    gameState.goats.forEach(goatPosition => {
        const goat = document.createElement("div");

        goat.classList.add("goat");
        goat.textContent = "🐐";

        const position = positions[goatPosition];
        const coordinates = getPositionCoordinates(position);

        goat.style.left = `${coordinates.x}%`;
        goat.style.top = `${coordinates.y}%`;

        goat.dataset.position = goatPosition;

        board.appendChild(goat);
    });
}


// function updategameStatusDisplay() {
//     if (gameState.turn === "tiger") {
//         gameStatusDisplay.textContent = "Tigers' Turn";
//     } else {
//         gameStatusDisplay.textContent = "Goats' Turn";
//     }
// }


function updateGameStatus() {

    // Turn
    if (gameState.turn === "tiger") {
        gameStatusDisplay.textContent = "Tigers' Turn";
    } else {
        gameStatusDisplay.textContent = "Goats' Turn";
    } 

    if (gameState.winner !== null) {
        if (gameState.winner === "Draw") {
            gameStatusDisplay.textContent = "Draw!";
            addGameLog("It's a Draw!");
        } else {
            gameStatusDisplay.textContent = `${gameState.winner} win!`;
            addGameLog(`${gameState.winner} win!`);
        }

    }

    if (gameState.winner !== null) {
        showGameOverPopup();
    }

    // Phase
    if (gameState.phase === "placement") {
        phaseDisplay.textContent = "Placement";
    } else {
        phaseDisplay.textContent = "Movement";
    }

    // Goat counts
    goatsPlacedDisplay.textContent = gameState.goatsPlaced;
    goatsOnBoardDisplay.textContent = gameState.goats.length;
    goatsCapturedDisplay.textContent = gameState.capturedGoats;
    

}






// =============================================================================================
// 5. HELPER FUNCTIONS
// =============================================================================================



function getPositionCoordinates(position) {
    const percentage = 100 / 4;

    return {
        x: position.col * percentage,
        y: position.row * percentage
    };
}






function getPieceAtPosition(position) {
    if (gameState.tigers.includes(position)) {
        return "tiger";
    }

    if (gameState.goats.includes(position)) {
        return "goat";
    }

    return null;
}




function getAdjacentPositions(position) {
    return connections[position];
}


function isPositionEmpty(position) {
    return getPieceAtPosition(position) === null;
}


function canPlaceGoat(position) {
    return isPositionEmpty(position);
}


function getPositionBeyond(from, middle) {

    // checking that from and middle are actual connections
    if (!connections[from].includes(middle)) {
        return null;
    }

    const fromPosition = positions[from];
    const middlePosition = positions[middle];

    const rowDifference = middlePosition.row - fromPosition.row;
    const colDifference = middlePosition.col - fromPosition.col;

    const targetRow = middlePosition.row + rowDifference;
    const targetCol = middlePosition.col + colDifference;

    const targetPosition = positions.find(position => {
        return (
            position.row === targetRow &&
            position.col === targetCol
        );
    });

    return targetPosition ? targetPosition.id : null;
}


function getPositionKey() {

    const tigers = [...gameState.tigers].sort((a, b) => a - b);
    const goats = [...gameState.goats].sort((a, b) => a - b);

    return `${tigers.join(",")}|${goats.join(",")}|${gameState.turn}`;
}


function recordPosition() {

    if (gameState.phase !== "movement") {
        return;
    }

    const key = getPositionKey();

    if (!gameState.positionHistory[key]) {
        gameState.positionHistory[key] = 0;
    }

    gameState.positionHistory[key]++;

    console.log(
        "Position:",
        key,
        "Count:",
        gameState.positionHistory[key]
    );

    return gameState.positionHistory[key];
}


function checkDrawCondition() {

    const key = getPositionKey();

    const count = gameState.positionHistory[key] || 0;

    if (count >= 4) {
        gameState.winner = "Draw";
        return true;
    }

    return false;
}


function checkGameEnd() {

    if (checkWinCondition()) {
        updateGameStatus();
        return true;
    }

    if (checkDrawCondition()) {
        updateGameStatus();
        return true;
    }

    return false;
}










// =============================================================================================
// 6. GAME LOGIC
// =============================================================================================

function getNormalTigerMoves(position) {
    const adjacentPositions = getAdjacentPositions(position);

    return adjacentPositions.filter(destination => {
        return isPositionEmpty(destination);
    });
}

function getNormalGoatMoves(position) {

    const adjacentPositions = getAdjacentPositions(position);

    return adjacentPositions.filter(destination => {
        return isPositionEmpty(destination);
    });
}


function moveTiger(from, to) {
    const tigerIndex = gameState.tigers.indexOf(from);

    if (tigerIndex === -1) {
        return false;
    }

    gameState.tigers[tigerIndex] = to;

    return true;
}



function isValidTigerMove(from, to) {
    const validMoves = getNormalTigerMoves(from);

    return validMoves.includes(to);
}



function placeGoat(position) {
    if (!isPositionEmpty(position)) {
        return false;
    }

    gameState.goats.push(position);
    gameState.goatsPlaced++;

    // after 20 goats placed
    if (gameState.goatsPlaced === 20) {
        gameState.phase = "movement";
    }

    return true;
}

function moveGoat(from, to) {

    const goatIndex = gameState.goats.indexOf(from);

    if (goatIndex === -1) {
        return false;
    }

    gameState.goats[goatIndex] = to;

    return true;
}

function isValidGoatMove(from, to) {

    const validMoves = getNormalGoatMoves(from);

    return validMoves.includes(to);
}

function switchTurn() {
    if (gameState.turn === "tiger") {
        gameState.turn = "goat";
    } else {
        gameState.turn = "tiger";
    }

    updateGameStatus();
}


function getTigerCaptures(position) {
    const captures = [];

    const adjacentPositions = getAdjacentPositions(position);

    for (const middle of adjacentPositions) {

        // There must be a goat between
        if (getPieceAtPosition(middle) !== "goat") {
            continue;
        }

        // Find the position beyond the goat
        const landingPosition = getPositionBeyond(position, middle);

        // There must be a valid landing position
        if (landingPosition === null) {
            continue;
        }

        // Landing position must be empty
        if (!isPositionEmpty(landingPosition)) {
            continue;
        }

        captures.push({
            middle: middle,
            landing: landingPosition
        });
    }

    return captures;
}


function getTigerCaptures(position) {

    const captures = [];

    const adjacentPositions = getAdjacentPositions(position);

    for (const middle of adjacentPositions) {

        // The middle position must contain a goat
        if (getPieceAtPosition(middle) !== "goat") {
            continue;
        }

        // Find the position beyond the goat
        const landing = getPositionBeyond(position, middle);

        // No valid position beyond the goat
        if (landing === null) {
            continue;
        }

        // The landing position must be empty
        if (!isPositionEmpty(landing)) {
            continue;
        }

        captures.push({
            middle: middle,
            landing: landing
        });
    }

    return captures;
}


function captureGoat(from, middle, landing) {

    // There must be a tiger at the starting position
    if (getPieceAtPosition(from) !== "tiger") {
        return false;
    }

    // There must be a goat in the middle
    if (getPieceAtPosition(middle) !== "goat") {
        return false;
    }

    // The landing position must be empty
    if (!isPositionEmpty(landing)) {
        return false;
    }

    // The middle position must be connected to the tiger
    if (!connections[from].includes(middle)) {
        return false;
    }

    // Calculate the actual position beyond the goat
    const actualLanding = getPositionBeyond(from, middle);

    // The requested landing position must match it
    if (actualLanding !== landing) {
        return false;
    }

    const goatIndex = gameState.goats.indexOf(middle);

    if (goatIndex === -1) {
        return false;
    }


    const tigerIndex = gameState.tigers.indexOf(from);

    if (tigerIndex === -1) {
        return false;
    }

    gameState.goats.splice(goatIndex, 1);

    gameState.tigers[tigerIndex] = landing;

    gameState.capturedGoats++;

    return true;
}


function selectGoat(position) {

    if (getPieceAtPosition(position) !== "goat") {
        return false;
    }

    gameState.selectedGoat = position;

    return true;
}


function checkWinCondition() {

    // Tigers win when all 20 goats have been captured
    if (
        gameState.goatsPlaced === 20 &&
        gameState.capturedGoats === 20
    ) {
        gameState.winner = "Tigers";
        return true;
    }

    // Check whether every tiger has no legal move
    let allTigersBlocked = true;

    for (const tigerPosition of gameState.tigers) {

        const normalMoves = getNormalTigerMoves(tigerPosition);
        const captures = getTigerCaptures(tigerPosition);
        console.log("checkwincondition:",tigerPosition,captures);
        if (normalMoves.length > 0 || captures.length > 0) {
            allTigersBlocked = false;
            break;
        }
    }

    // Goats win when all tigers are blocked
    if (allTigersBlocked) {
        gameState.winner = "Goats";
        return true;
    }

    return false;
}










// =============================================================================================
// 7. USER INTERACTION
// =============================================================================================

function setupBoardClicks() {
    const points = document.querySelectorAll(".board-point");

    points.forEach(point => {
        point.addEventListener("click", handlePositionClick);
    });
}




function handlePositionClick(event) {

    if (gameState.winner !== null) {
        gameLogDisplay("Game is already over.");
        return;
    }

    const position = Number(event.currentTarget.dataset.position);
    console.log(`Position ${position} clicked!`)


    // ==============================
    // GOAT'S TURN
    // ==============================

    if (gameState.turn === "goat") {

        // GOAT PLACEMENT PHASE
        if (gameState.phase === "placement") {

            if (canPlaceGoat(position)) {
                placeGoat(position);

                addGameLog(`Goat placed at ${position}`);

                drawBoard();
                setupBoardClicks();
                switchTurn();

                if (checkGameEnd()) {
                    return;
                }

                updateGameStatus();

            } else {
                console.log("Cannot place goat here.");
            }

            return;
        }

        // GOAT MOVEMENT PHASE
        if (gameState.phase === "movement") {

            const piece = getPieceAtPosition(position);

            // No goat selected yet
            if (gameState.selectedGoat === null) {

                if (piece === "goat") {

                    selectGoat(position);
                    updateSelectionDisplay();
                    showValidGoatMoves();

                    console.log("Goat selected:", position);

                } else {

                    console.log("Please select a goat.");

                }

                return;
            }

            // A goat is already selected

            // User clicked another goat
            if (piece === "goat") {

                // Clicked the same goat → deselect
                if (position === gameState.selectedGoat) {

                    gameState.selectedGoat = null;
                    updateSelectionDisplay();
                    showValidGoatMoves();

                    console.log("Goat deselected.");

                } else {

                    // Clicked a different goat → switch selection
                    gameState.selectedGoat = position;
                    updateSelectionDisplay();
                    showValidGoatMoves();

                    console.log("Goat selection changed to:", position);

                }

                return;
            }


            // User clicked an empty position

            const from = gameState.selectedGoat;

            if (isValidGoatMove(from, position)) {

                moveGoat(from, position);

                addGameLog(`Goat moved from ${from} to ${position}`);

                gameState.selectedGoat = null;

                drawBoard();
                setupBoardClicks();

                switchTurn();

                recordPosition();

                if (checkGameEnd()) {
                    return;
                }

                updateGameStatus();

            } else {

                console.log("Invalid goat move.");

            }

            return;
        }
        
    }


    // ==============================
    // TIGER'S TURN
    // ==============================

    const piece = getPieceAtPosition(position);

    // No tiger is currently selected
    if (gameState.selectedPosition === null) {

        if (piece === "tiger") {
            gameState.selectedPosition = position;

            updateSelectionDisplay();
            showValidMoves();

            console.log("Tiger selected:", position);
        } else {
            console.log("Please select a tiger.");
        }

        return;
    }

    // A tiger is already selected
    const from = gameState.selectedPosition;

    // User clicked another tiger
    if (piece === "tiger") {

        if (position === gameState.selectedPosition) {
            gameState.selectedPosition = null;

            updateSelectionDisplay();
            showValidMoves();

            console.log("Tiger deselected.");

            return;
        }

        gameState.selectedPosition = position;

        updateSelectionDisplay();
        showValidMoves();

        console.log("Tiger selection changed to:", position);

        return;
    }

    // User clicked an empty position

    //check for captures
    const captures = getTigerCaptures(from);

    const capture = captures.find(capture => {
        return capture.landing === position;
    });

    if (capture) {

        const success = captureGoat(
            from,
            capture.middle,
            capture.landing
        );

        if (success) {
            addGameLog(
                `Tiger from ${from} captured goat at ${capture.middle} and moved to ${capture.landing}`
            );

            gameState.selectedPosition = null;

            drawBoard();
            setupBoardClicks();
            switchTurn();

            recordPosition();

            if (checkGameEnd()) {
                return;
            }

            updateGameStatus();
        }

        return;
    }

    // check for normal move
    if (isValidTigerMove(from, position)) {

        moveTiger(from, position);

        addGameLog(`Tiger moved from ${from} to ${position}`);

        gameState.selectedPosition = null;

        drawBoard();
        setupBoardClicks();

        switchTurn();

        recordPosition();

        if (checkGameEnd()) {
            return;
        }

        updateGameStatus();

    } else {
        console.log("Invalid tiger move.");
    }
}




function updateSelectionDisplay() {
    // console.log("updateSelectionDisplay called");
    // console.log("Selected tiger:", gameState.selectedPosition);
    // console.log("Selected goat:", gameState.selectedGoat);

    // tiger selection
    document.querySelectorAll(".tiger").forEach(tiger => {
        tiger.classList.remove("selected");

        const position = Number(tiger.dataset.position);

        if (position === gameState.selectedPosition) {
            tiger.classList.add("selected");
        }
    });

    // goat selection
    document.querySelectorAll(".goat").forEach(goat => {

        goat.classList.remove("selected");

        const position = Number(goat.dataset.position);

        if (position === gameState.selectedGoat) {
            goat.classList.add("selected");
        }
    });
}




function showValidMoves() {
    document.querySelectorAll(".board-point").forEach(point => {
        point.classList.remove("valid-move");
        point.classList.remove("capture-move");
    });

    const selectedPosition = gameState.selectedPosition;

    if (selectedPosition === null) {
        return;
    }

    const normalMoves = getNormalTigerMoves(selectedPosition);
    const captures = getTigerCaptures(selectedPosition);

    console.log("Normal moves:", normalMoves);
    console.log("Captures:", captures);

    // Highlight ordinary moves
    document.querySelectorAll(".board-point").forEach(point => {
        const position = Number(point.dataset.position);

        if (normalMoves.includes(position)) {
            point.classList.add("valid-move");
        }
    });

    // Highlight capture moves with stronger color
    captures.forEach(capture => {
        document
            .querySelector(`.board-point[data-position="${capture.landing}"]`)
            .classList.add("capture-move");
    });
}



function showValidGoatMoves() {

    // Remove previous goat move highlights
    document.querySelectorAll(".board-point").forEach(point => {
        point.classList.remove("valid-move");
    });

    const selectedGoat = gameState.selectedGoat;

    // No goat selected
    if (selectedGoat === null) {
        return;
    }

    const validMoves = getNormalGoatMoves(selectedGoat);

    console.log("Valid goat moves:", validMoves);

    document.querySelectorAll(".board-point").forEach(point => {

        const position = Number(point.dataset.position);

        if (validMoves.includes(position)) {
            point.classList.add("valid-move");
        }
    });
}


function resetGame() {

    gameState.tigers = [0, 4, 20, 24];
    gameState.goats = [];

    gameState.goatsPlaced = 0;
    gameState.capturedGoats = 0;

    gameState.turn = "goat";
    gameState.phase = "placement";

    gameState.selectedPosition = null;
    gameState.selectedGoat = null;

    gameState.winner = null;

    gameState.positionHistory = {};

    recordPosition();

    drawBoard();
    setupBoardClicks();
    updateGameStatus();

    addGameLog("New game started.");
}
newGameButton.addEventListener("click", resetGame);


function showGameOverPopup() {

    if (gameState.winner === null) {
        return;
    }

    if (gameState.winner === "Draw") {

        gameOverTitle.textContent = "🤝 Draw!";
        gameOverMessage.textContent =
            "The same position was repeated.";

    } else if (gameState.winner === "Tigers") {

        gameOverTitle.textContent = "🐯 Tigers Win!";
        gameOverMessage.textContent =
            "All goats have been captured.";

    } else if (gameState.winner === "Goats") {

        gameOverTitle.textContent = "🐐 Goats Win!";
        gameOverMessage.textContent =
            "The tigers have been blocked.";

    }

    gameOverOverlay.style.display = "flex";
}

gameOverNewGame.addEventListener("click", () => {

    gameOverOverlay.style.display = "none";

    resetGame();

});






// =============================================================================================
// 8. INITIALIZATION
// =============================================================================================


drawBoard();
setupBoardClicks();

updateGameStatus();
recordPosition();
// console.log(getPositionBeyond(2,12));
// console.log(getTigerCaptures(0));
// console.log("Captures from 0:", getTigerCaptures(0));
