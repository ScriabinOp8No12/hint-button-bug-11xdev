/*
 * Copyright (C)  Online-Go.com
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import moment from "moment";
import * as React from "react";
import * as data from "@/lib/data";
import * as preferences from "@/lib/preferences";
import Select, { components } from "react-select";
import { UIPush } from "@/components/UIPush";
import { AIReviewStream, ai_request_variation_analysis } from "@/components/AIReviewStream";
import { openBecomeASiteSupporterModal } from "@/views/Supporter";
import { errorAlerter, errorLogger, Timeout } from "@/lib/misc";
import { toast } from "@/lib/toast";
import { get, post } from "@/lib/requests";
import { _, pgettext, interpolate } from "@/lib/translate";
import { close_all_popovers } from "@/lib/popover";
import { Errcode } from "@/components/Errcode";
import { AIReviewChart } from "./AIReviewChart";
import { Toggle } from "@/components/Toggle";
import {
    MoveTree,
    JGOFAIReview,
    JGOFAIReviewMove,
    JGOFIntersection,
    JGOFNumericPlayerColor,
    ColoredCircle,
    getWorstMoves,
    AIReviewWorstMoveEntry,
    Goban,
    encodeMoves,
    encodeMove,
    GobanRenderer,
} from "goban";
import { game_control } from "./game_control";
import { alert } from "@/lib/swal_config";
import { GobanContext } from "./goban_context";
import { ReportContext } from "@/contexts/ReportContext";
import { MODERATOR_POWERS } from "@/lib/moderation";

export interface AIReviewEntry {
    move_number: number;
    win_rate: number;
    score: number;
    num_variations: number;
}

interface AIReviewProperties {
    move: MoveTree;
    game_id: number;
    hidden: boolean;
    onAIReviewSelected: (ai_review: JGOFAIReview) => void;
    reportContext?: React.ContextType<typeof ReportContext>;
    gobanContext?: React.ContextType<typeof GobanContext>;
}

interface AIReviewState {
    loading: boolean;
    reviewing: boolean;
    use_score: boolean;
    ai_reviews: Array<JGOFAIReview>;
    selected_ai_review?: JGOFAIReview;
    update_count: number;
    worst_moves_shown: number;
    hide_table: boolean;
    table_hidden: boolean;
}

// We need this wrapped because we want to access two contexts,
// and we can't do that in a function component.
// This wil be a lot cleaner when we convert it to a function component.
export function AIReview(props: AIReviewProperties) {
    return (
        <ReportContext.Consumer>
            {(reportContext) => (
                <GobanContext.Consumer>
                    {(gobanContext) => (
                        <AIReviewClass
                            {...props}
                            reportContext={reportContext}
                            gobanContext={gobanContext}
                        />
                    )}
                </GobanContext.Consumer>
            )}
        </ReportContext.Consumer>
    );
}

class AIReviewClass extends React.Component<AIReviewProperties, AIReviewState> {
    ai_review?: JGOFAIReview;
    table_rows!: string[][];
    avg_score_loss!: number[];
    median_score_loss!: number[];
    moves_pending!: number;
    max_entries!: number;

    constructor(props: AIReviewProperties) {
        super(props);
        const state: AIReviewState = {
            loading: true,
            reviewing: false,
            ai_reviews: [],
            update_count: 0,
            use_score: preferences.get("ai-review-use-score"),
            // TODO: allow users to view more than 3 of these key moves
            // See https://forums.online-go.com/t/top-3-moves-score-a-better-metric/32702/15
            worst_moves_shown: 6,
            hide_table: false,
            table_hidden: preferences.get("ai-summary-table-show"),
        };
        this.state = state;
        window.aireview = this;
    }

    powerToSeeTable(moderator_powers: number | undefined) {
        return (
            ((moderator_powers ?? 0) & MODERATOR_POWERS.AI_DETECTOR) !== 0 ||
            ((moderator_powers ?? 0) & MODERATOR_POWERS.ASSESS_AI_PLAY) !== 0
        );
    }

    componentDidMount() {
        this.getAIReviewList();
        const ai_table_out = this.AiSummaryTableRowList();
        this.table_rows = ai_table_out.ai_table_rows;
        this.avg_score_loss = ai_table_out.avg_score_loss;
        this.median_score_loss = ai_table_out.median_score_loss;
        this.moves_pending = ai_table_out.moves_pending;
        this.max_entries = ai_table_out.max_entries;

        const user = data.get("user");
        const canViewTable =
            user.is_moderator || this.powerToSeeTable(this.props.reportContext?.moderator_powers);

        this.setState({
            hide_table: !canViewTable,
        });
    }

    componentDidUpdate(prevProps: AIReviewProperties) {
        if (this.getGameId() !== this.getGameId(prevProps)) {
            this.getAIReviewList();
        }
        if (!this.state.hide_table) {
            const ai_table_out = this.AiSummaryTableRowList();
            this.table_rows = ai_table_out.ai_table_rows;
            this.avg_score_loss = ai_table_out.avg_score_loss;
            this.median_score_loss = ai_table_out.median_score_loss;
            this.moves_pending = ai_table_out.moves_pending;
            this.max_entries = ai_table_out.max_entries;
        }
    }

    getGameId(props?: AIReviewProperties) {
        if (!props) {
            props = this.props;
        }

        if (props.game_id) {
            return props.game_id;
        }
        return null;
    }
    getAIReviewList() {
        const game_id = this.getGameId();
        if (!game_id) {
            return;
        }

        let start_review_attempts_left = 3;
        const start_review = () => {
            if (start_review_attempts_left === 0) {
                console.error("Giving up trying to start AI review");
                return;
            }
            --start_review_attempts_left;

            post(`games/${game_id}/ai_reviews`, {
                engine: "katago",
                type: "auto",
            })
                .then((res) => {
                    sanityCheck(res);
                    if (res.id) {
                        this.setState({ reviewing: true });
                    }
                })
                .catch((err) => {
                    console.error("Failed to start AI review", err);
                    setTimeout(start_review, 500);
                });
        };

        get(`games/${game_id}/ai_reviews`)
            .then((lst: Array<JGOFAIReview>) => {
                this.setState({
                    loading: false,
                    ai_reviews: lst,
                });

                if (lst.length) {
                    /* Select the best AI review */
                    lst = lst.sort((a, b) => {
                        if (a.type !== b.type) {
                            return a.type === "full" ? -1 : 1;
                        }

                        /*
                        if (a.network_size < b.network_size) {
                            return 1;
                        }
                        if (b.network_size < a.network_size) {
                            return -1;
                        }
                        */

                        if (a.strength - b.strength !== 0) {
                            return b.strength - a.strength;
                        }

                        return new Date(b.date).getTime() - new Date(a.date).getTime();
                    });
                    //console.log("List: ", lst);
                    this.setSelectedAIReview(lst[0]);
                } else {
                    start_review();
                }
            })
            .catch(errorLogger);
    }

    private static handicapOffset(goban: GobanRenderer): number {
        if (
            goban &&
            goban.engine &&
            goban.engine.free_handicap_placement &&
            goban.engine.handicap > 0
        ) {
            return goban.engine.handicap;
        }
        return 0;
    }

    syncAIReview() {
        if (!this.ai_review || !this.state.selected_ai_review) {
            this.setState({
                update_count: this.state.update_count + 1,
            });
            return;
        }

        const ai_review: JGOFAIReview = this.ai_review;

        if (!ai_review.win_rates) {
            ai_review.win_rates = [];
        }

        for (const k in ai_review.moves) {
            const move = ai_review.moves[k];
            ai_review.win_rates[move.move_number] = move.win_rate;
            if (move.score !== undefined && ai_review.scores !== undefined) {
                ai_review.scores[move.move_number] = move.score;
            }
        }

        /* For old reviews, we might not have all win rates, so fill in the missing entries */
        let last_win_rate = 0.5;
        for (let move_number = 0; move_number < ai_review.win_rates.length; ++move_number) {
            if (ai_review.win_rates[move_number] === undefined) {
                ai_review.win_rates[move_number] = last_win_rate;
            }
            last_win_rate = ai_review.win_rates[move_number];
        }

        /* TODO: Blunder count & top3 move array */

        this.setState({
            loading: false,
            //top3: null,
            //blunders: blunders,
            //queue_position: this.state.selected_ai_review.queue.position,
            //queue_pending: this.state.selected_ai_review.queue.pending,
            update_count: this.state.update_count + 1,
        });
    }

    setSelectedAIReview = (ai_review: JGOFAIReview) => {
        close_all_popovers();
        const user = data.get("user");
        const canViewTable =
            user.is_moderator || this.powerToSeeTable(this.props.reportContext?.moderator_powers);
        this.updateAIReviewMetadata(ai_review);
        this.setState({
            selected_ai_review: ai_review,
            hide_table: !canViewTable,
        });
        this.props.onAIReviewSelected(ai_review);
        this.syncAIReview();
    };
    startNewAIReview(analysis_type: "fast" | "full", engine: "leela_zero" | "katago") {
        const user = data.get("user");

        if (user.anonymous) {
            void alert.fire(_("Please sign in first"));
        } else {
            if (
                user.supporter ||
                user.professional ||
                user.is_moderator ||
                (user.moderator_powers & MODERATOR_POWERS.AI_DETECTOR) !== 0
            ) {
                post(`games/${this.getGameId()}/ai_reviews`, {
                    type: analysis_type,
                    engine: engine,
                })
                    .then((res) => {
                        sanityCheck(res);
                        toast(<div>{_("Analysis started")}</div>, 2000);
                    })
                    .catch(errorAlerter);
            } else {
                openBecomeASiteSupporterModal();
            }
        }
    }

    updateAIReviewMetadata(ai_review: JGOFAIReview): void {
        sanityCheck(ai_review);
        if (!this.ai_review || this.ai_review.uuid !== ai_review.uuid) {
            this.ai_review = ai_review;
        } else {
            for (const k in ai_review) {
                //console.log("Updating", k, ai_review[k]);
                if (k !== "moves" || !this.ai_review["moves"]) {
                    (this.ai_review as any)[k] = (ai_review as any)[k];
                } else {
                    for (const move in ai_review["moves"]) {
                        this.ai_review["moves"][move] = ai_review["moves"][move];
                    }
                }
            }
        }
        this.setState({
            update_count: this.state.update_count + 1,
        });
    }

    deferred_update_timeout?: Timeout;
    deferred_queue?: { [key: string]: any };

    updateAiReview = (data: any) => {
        if (this.deferred_queue) {
            for (const key in data) {
                this.deferred_queue[key] = data[key];
            }
        } else {
            this.deferred_queue = data;
            this.deferred_update_timeout = setTimeout(() => {
                const data = this.deferred_queue;
                delete this.deferred_update_timeout;
                delete this.deferred_queue;

                for (const key in data) {
                    const value = data[key];
                    if (key === "metadata") {
                        this.updateAIReviewMetadata(value as JGOFAIReview);
                    } else if (key === "error") {
                        if (this.ai_review) {
                            this.ai_review.error = value;
                        } else {
                            console.error("AI Review missing, cannot update error", value);
                        }
                    } else if (/move-[0-9]+/.test(key)) {
                        if (!this.ai_review) {
                            console.warn(
                                "AI Review move received but ai review not initialized yet",
                            );
                            return;
                        }

                        const m = key.match(/move-([0-9]+)/) as string[];
                        const move_number = parseInt(m[1]);
                        this.ai_review.moves[move_number] = value;
                    } else if (/variation-([0-9]+)-([!12a-z.A-Z-]+)/.test(key)) {
                        if (!this.ai_review) {
                            console.warn(
                                "AI Review move received but ai review not initialized yet",
                            );
                            return;
                        }
                        if (!this.ai_review.analyzed_variations) {
                            this.ai_review.analyzed_variations = {};
                        }
                        const m = key.match(/variation-([!0-9a-z.A-Z-]+)/) as string[];
                        const var_key = m[1];
                        this.ai_review.analyzed_variations[var_key] = value;
                    } else {
                        console.warn(`Unrecognized key in updateAiReview data: ${key}`, value);
                    }
                }

                if (this.ai_review) {
                    sanityCheck(this.ai_review);
                }
                this.setState({
                    update_count: this.state.update_count + 1,
                });
                this.syncAIReview();
            }, 100);
        }
    };

    ai_review_update = (data: any) => {
        if ("refresh" in data) {
            this.getAIReviewList();
        }
    };

    private getVariationReviewEntries(): Array<AIReviewEntry> {
        if (!this.ai_review) {
            return [];
        }

        const ret: Array<AIReviewEntry> = [];
        let cur_move = this.props.move;
        const trunk_move = cur_move.getBranchPoint();
        const trunk_move_string = trunk_move.getMoveStringToThisPoint();

        while (cur_move.id !== trunk_move.id) {
            const cur_move_string = cur_move.getMoveStringToThisPoint();
            const var_string = cur_move_string.slice(trunk_move_string.length);
            const var_key = `${trunk_move.move_number}-${var_string}`;

            // if we have an interactive review move, that's what we're interested in
            if (
                this.ai_review.analyzed_variations &&
                var_key in this.ai_review.analyzed_variations
            ) {
                const analysis = this.ai_review.analyzed_variations[var_key];
                ret.push({
                    move_number: analysis.move_number,
                    win_rate: analysis.win_rate,
                    score: analysis.score || 0,
                    num_variations: analysis.branches.length,
                });
            }

            if (!cur_move.parent) {
                break;
            }
            cur_move = cur_move.parent;
        }

        ret.reverse();

        return ret;
    }

    public updateHighlightsMarksAndHeatmaps(): [number, number, number | null, string] {
        if (!this.ai_review) {
            throw new Error("ai_review not set");
        }

        const goban = this.props.gobanContext;

        if (!goban) {
            throw new Error("goban not set");
        }

        let ai_review_move: JGOFAIReviewMove | undefined;
        let next_ai_review_move: JGOFAIReviewMove | undefined;
        let win_rate: number;
        let score: number;
        let next_win_rate: number;
        let next_score: number | undefined;
        let next_move: MoveTree | undefined | null = null;
        let next_move_delta_win_rate: number | null = null;
        const cur_move = this.props.move;
        const trunk_move = cur_move.getBranchPoint();
        const move_number = trunk_move.move_number;
        let next_move_pretty_coords = "";

        const trunk_move_string = trunk_move.getMoveStringToThisPoint();
        const cur_move_string = cur_move.getMoveStringToThisPoint();
        const var_string = cur_move_string.slice(trunk_move_string.length);
        const var_key = `${trunk_move.move_number}-${var_string}`;
        let have_variation_results = false;

        // if we have an interactive review move, display that.
        // otherwise, look for one that came from the normal review.
        if (this.ai_review.analyzed_variations && var_key in this.ai_review.analyzed_variations) {
            have_variation_results = true;
            ai_review_move = this.ai_review.analyzed_variations[var_key];
        } else {
            if (this.ai_review.moves[move_number]) {
                /* check if the nearest trunk move was one of the top three moves reviewed by ai */
                ai_review_move =
                    this.ai_review.moves[
                        move_number
                    ]; /* ai_review_move now contains data regarding all the branches played out by the AI */
            }

            if (this.ai_review.moves[move_number + 1]) {
                next_ai_review_move = this.ai_review.moves[move_number + 1];
            }
        }

        const win_rates = this.ai_review?.win_rates || [];
        const scores = this.ai_review?.scores || [];

        if (ai_review_move) {
            win_rate = ai_review_move.win_rate;
            score = ai_review_move.score || 0;
        } else {
            win_rate = win_rates[move_number] || this.ai_review.win_rate;
            score = scores[move_number];
            /*
            if (!score && score !== 0) {
                this.ai_review.scores ? this.ai_review.scores[-1] : 0;
            }
            */
            // Fixes when current move is out of range of ai_review.scores array
            if (!score && score !== 0) {
                if (scores?.some((s) => typeof s === "number")) {
                    const last_score =
                        scores
                            .slice(0, move_number + 1)
                            .reverse()
                            .find((s) => s) || 0;
                    if (last_score && last_score !== 0) {
                        score = last_score;
                    }
                }
            }
        }

        if (next_ai_review_move) {
            next_win_rate = next_ai_review_move.win_rate;
            next_score = next_ai_review_move.score;
        } else {
            next_win_rate = win_rates[move_number + 1] || win_rate;
            next_score = scores[move_number + 1] || score;
        }

        let marks: { [mark: string]: string } = {};
        const colored_circles: ColoredCircle[] = [];
        let heatmap: Array<Array<number>> | null = null;
        try {
            if ((cur_move.trunk || have_variation_results) && ai_review_move) {
                /* if we are on a trunk move that was AI reviewed */
                next_move = cur_move.trunk_next;
                const branches = ai_review_move.branches.slice(0, 6);
                //let branches = ai_review_move.branches;

                // Ensure we have an entry in branches for our next move,
                // as we always want to show what move was made and how
                // that affected the game. Also, if we do have an entry,
                // make sure it's win rate aligns with what we determined
                // it was upon further analysis (use next move's win rate)
                let found_next_move = false;
                for (const branch of branches) {
                    if (branch.moves.length === 0) {
                        continue;
                    }
                    if (next_move && isEqualMoveIntersection(branch.moves[0], next_move)) {
                        found_next_move = true;
                        branch.win_rate = next_win_rate;
                        branch.score = next_score;
                        break;
                    }
                }
                if (!found_next_move && next_move) {
                    branches.push({
                        moves: [next_move],
                        win_rate: next_win_rate,
                        score: next_score,
                        visits: 0,
                    });
                }

                /* Generate the heatmap, blue move, and triangle move */
                const strength = this.ai_review.strength;
                heatmap = [];
                for (let y = 0; y < goban.engine.height; y++) {
                    const r: number[] = [];
                    for (let x = 0; x < goban.engine.width; x++) {
                        r.push(0);
                    }
                    heatmap.push(r);
                }

                for (let i = 0; i < branches.length; ++i) {
                    const branch = branches[i];
                    const mv = branch.moves[0];

                    if (mv === undefined || mv.x === -1) {
                        continue;
                    }

                    if (goban.engine.board[mv.y][mv.x]) {
                        console.error(
                            "ERROR: AI is suggesting moves on intersections that have already been played, this is likely a move indexing error.",
                        );
                        console.info("AIReview: ", this.ai_review);
                    }

                    heatmap[mv.y][mv.x] = branch.visits / strength;

                    let next_player: JGOFNumericPlayerColor;

                    if (next_move) {
                        next_player = next_move.player;
                    } else {
                        // we don't always use this because when we are looking at handicap stones, it doesn't flip.
                        next_player =
                            cur_move.player === JGOFNumericPlayerColor.BLACK
                                ? JGOFNumericPlayerColor.WHITE
                                : JGOFNumericPlayerColor.BLACK;
                    }

                    const delta: number =
                        this.state.use_score && this.ai_review.scores
                            ? next_player === JGOFNumericPlayerColor.WHITE
                                ? (ai_review_move.score ?? 0) - (branch.score ?? 0)
                                : (branch.score ?? 0) - (ai_review_move.score ?? 0)
                            : 100 *
                              (next_player === JGOFNumericPlayerColor.WHITE
                                  ? ai_review_move.win_rate - branch.win_rate
                                  : branch.win_rate - ai_review_move.win_rate);

                    let key = delta.toFixed(1);
                    if (key === "0.0" || key === "-0.0") {
                        key = "0";
                    }
                    // only show numbers for well explored moves
                    // show number for AI choice and played moves[0] as well
                    if (
                        mv &&
                        (i === 0 ||
                            //true || // debugging
                            (next_move && isEqualMoveIntersection(branch.moves[0], next_move)) ||
                            branch.visits >= Math.min(50, 0.1 * strength))
                    ) {
                        if (parseFloat(key).toPrecision(2).length < key.length) {
                            key = parseFloat(key).toPrecision(2);
                        }
                        goban.setSubscriptMark(mv.x, mv.y, key, true);
                    }

                    const circle: ColoredCircle = {
                        move: branch.moves[0],
                        color: "rgba(0,0,0,0)",
                    };

                    if (next_move && isEqualMoveIntersection(branch.moves[0], next_move)) {
                        goban.setMark(mv.x, mv.y, "sub_triangle", true);
                        goban.setMark(mv.x, mv.y, "blue_move", true);

                        circle.border_width = 0.1;
                        circle.border_color = "rgb(0, 0, 0)";
                        if (i === 0) {
                            circle.color = "rgba(0, 130, 255, 0.7)";
                        } else {
                            circle.color = "rgba(255, 255, 255, 0.3)";
                        }
                        colored_circles.push(circle);
                    } else if (i === 0) {
                        // blue move, not what player made
                        goban.setMark(mv.x, mv.y, "blue_move", true);
                        circle.border_width = 0.2;
                        circle.border_color = "rgb(0, 130, 255)";
                        circle.color = "rgba(0, 130, 255, 0.7)";
                        colored_circles.push(circle);
                    }
                }
            } else {
                /* if not on trunk move which was ai reviewed, see if we have some reviewed data */
                if (!cur_move.trunk) {
                    this.requestAnalysisOfVariation(cur_move, trunk_move);
                }
                /* fill marks object with AI ghost marks, if we are on a sequence the AI played out */
                this.fillAIMarksBacktracking(cur_move, trunk_move, marks);
            }
        } catch (e) {
            errorLogger(e);
        }

        // Reduce moves shown to the variation-move-count from settings
        marks = this.trimMaxMoves(marks);

        try {
            goban.setMarks(marks, true); /* draw the remaining AI sequence as ghost marks, if any */
            goban.setHeatmap(heatmap as any, true);
            goban.setColoredCircles(colored_circles, false);
        } catch (e) {
            errorLogger(e);
        }

        if (next_win_rate >= 0) {
            next_move_delta_win_rate = next_win_rate - win_rate;
            if (goban.engine.colorToMove() === "white") {
                next_move_delta_win_rate = -next_move_delta_win_rate;
            }
        }

        if (next_move) {
            next_move_pretty_coords = goban.engine.prettyCoordinates(next_move.x, next_move.y);
        }

        return [win_rate, score, next_move_delta_win_rate, next_move_pretty_coords];
    }

    private trimMaxMoves(marks: { [mark: string]: string }): { [mark: string]: string } {
        // Reduces the number of moves ahead shown in a the variation if the user has set it to non-zero
        const maxMoves = preferences.get("variation-move-count");
        // Move object has more than just one move in it and the user has set the non-zero value
        if (maxMoves < 10 && Object.keys(marks).length > 2) {
            // Get all the moves into an array but leave the black and white keys since we'll append them later
            let marksArray = Object.entries(marks).reduce(
                (result, entry) => {
                    if (entry[0] !== "black" && entry[0] !== "white") {
                        result.push({ key: entry[0], value: entry[1] });
                    }
                    return result;
                },
                [] as { key: string; value: string }[],
            );

            // use the max moves set by teh user or the number of moves in the variation, whichever is lower
            const actualMoves = marksArray.length > maxMoves ? maxMoves : marksArray.length;

            // Chop off anything after the number of moves we want
            marksArray = marksArray.slice(0, actualMoves);

            // Work out whose move the first move is
            let blackFirstMove: boolean;
            if (marks.black.substring(0, 2) === marksArray[0].value) {
                blackFirstMove = true;
            } else {
                blackFirstMove = false;
            }

            // See if we have an odd number of moves
            const oddMoves = actualMoves % 2 > 0;

            // Black and white have half the moves each...
            let blackMoves = Math.floor(actualMoves / 2);
            let whiteMoves = blackMoves;

            // ... plus one for whoever moves first (if an odd number of moves)
            if (oddMoves) {
                if (blackFirstMove) {
                    blackMoves++;
                } else {
                    whiteMoves++;
                }
            }

            // Work out how many characters (2 per move) we should restrict the transparency string to for each
            const blackMoveString = marks.black.substring(0, 2 * blackMoves);
            const whiteMoveString = marks.white.substring(0, 2 * whiteMoves);

            // Add back the black and white keys with the transparency strings if each is non-blank.
            // Seems ok to put a blank value but it may have unintended consequences.
            if (blackMoveString) {
                marksArray.push({
                    key: "black",
                    value: blackMoveString,
                });
            }

            if (whiteMoveString) {
                marksArray.push({
                    key: "white",
                    value: whiteMoveString,
                });
            }

            // Convert teh array back into an object
            marks = marksArray.reduce(
                (target, item) => (((target as any)[item.key] = item.value), target),
                {},
            );
        }

        //Return the result
        return marks;
    }

    private requestAnalysisOfVariation(cur_move: MoveTree, trunk_move: MoveTree): boolean {
        const goban = this.props.gobanContext;
        if (!goban) {
            return false;
        }

        const user = data.get("user");
        if (user.anonymous) {
            //console.debug("Anonymous user, not performing analysis of variation");
            return false;
        }
        if (!user.supporter) {
            //console.debug("user is not a supporter");
            return false;
        }

        const black_id = goban?.engine?.config?.black_player_id;
        const white_id = goban?.engine?.config?.white_player_id;
        const creator_id = game_control.creator_id;

        if (user.id !== black_id && user.id !== white_id && user.id !== creator_id) {
            //console.debug("Not performing analysis of variation for non player");
            return false;
        }

        if (!this.ai_review) {
            console.warn("ai_review not set");
            return false;
        }

        if (!this.state.selected_ai_review?.id) {
            console.warn("selected_ai_review?.id was not set");
            return false;
        }

        ai_request_variation_analysis(
            this.ai_review.uuid,
            this.props.game_id,
            Number(this.state.selected_ai_review?.id),
            cur_move,
            trunk_move,
        );

        return true;
    }

    /** This method attempts to match our cur_move sequence with any of the AI
     * generated sequences starting from the nearest trunk move (iterating
     * through previous trunk moves if necessary) and breaks out as soon as it
     * finds a match. The reason why we iterate through previous trunk moves is
     * to solve the problem when the trunk moves happen to coincide with the AI
     * generated sequence once match is found we fill marks object with the
     * remaining AI sequence.
     * @returns true if we found some data, false otherwise
     */
    private fillAIMarksBacktracking(
        cur_move: MoveTree,
        trunk_move: MoveTree,
        marks: { [mark: string]: string },
    ): boolean {
        if (!this.ai_review) {
            throw new Error("ai_review not set");
        }

        const goban = this.props.gobanContext;

        if (!goban) {
            throw new Error("goban not set");
        }

        for (let j = 0; j <= trunk_move.move_number; j++) {
            /* for each of the trunk moves starting from the nearest */
            const ai_review_move = this.ai_review.moves[trunk_move.move_number - j];
            if (!ai_review_move) {
                continue;
            }

            let trunk_move_string = trunk_move.getMoveStringToThisPoint();

            trunk_move_string = trunk_move_string.slice(0, trunk_move_string.length - 2 * j);

            const cur_move_string = cur_move.getMoveStringToThisPoint();
            let next_moves: string | undefined;

            for (const branch of ai_review_move.branches) {
                const move_str: string = trunk_move_string + encodeMoves(branch.moves);
                if (move_str.startsWith(cur_move_string)) {
                    next_moves = move_str.slice(cur_move_string.length, Infinity);
                    break;
                }
            }

            if (next_moves) {
                const decoded_moves = goban.engine.decodeMoves(next_moves);
                let black = "";
                let white = "";

                for (let i = 0; i < decoded_moves.length; ++i) {
                    const mv = decoded_moves[i];
                    const encoded_mv = encodeMove(mv.x, mv.y);
                    marks[i + cur_move.getDistance(trunk_move) + 1] = encoded_mv;
                    if ((goban.engine.player - 1 + i) % 2 === 1) {
                        white += encoded_mv;
                    } else {
                        black += encoded_mv;
                    }
                }
                if (black) {
                    marks["black"] = black;
                }
                if (white) {
                    marks["white"] = white;
                }
                return true; /* match found, no need to check previous trunk moves anymore, return */
            }
        }

        return false;
    }

    private static getPlayerColorsMoveList(goban: Goban) {
        const init_move = goban.engine.move_tree;
        const move_list: any[] = [];
        let cur_move = init_move.trunk_next;

        while (cur_move !== undefined) {
            move_list.push(cur_move.player);
            cur_move = cur_move.trunk_next;
        }
        return move_list;
    }

    private medianList(numbers: number[]): number {
        const mid = numbers.length === 0 ? undefined : Math.floor(numbers.length / 2);
        if (mid === undefined) {
            return -1;
        }

        const median =
            numbers.length % 2 !== 0 ? numbers[mid] : (numbers[mid] + numbers[mid - 1]) / 2;
        return median;
    }

    private AiSummaryTableRowList() {
        const goban = this.props.gobanContext;
        if (!goban) {
            throw new Error("goban not set");
        }

        const summary_moves_list = [
            ["", "", "", ""],
            ["", "", "", ""],
            ["", "", "", ""],
            ["", "", "", ""],
            ["", "", "", ""],
            ["", "", "", ""],
        ];
        const ai_table_rows = [
            [_("Excellent")],
            [_("Great")],
            [_("Good")],
            [_("Inaccuracy")],
            [_("Mistake")],
            [_("Blunder")],
        ];
        const default_table_rows = [["", "", "", "", ""]];
        const avg_score_loss = [0, 0];
        const median_score_loss = [0, 0];
        let moves_missing = 0;
        let max_entries = 0;

        if (!this.ai_review) {
            return {
                ai_table_rows: default_table_rows,
                avg_score_loss,
                median_score_loss,
                moves_pending: moves_missing,
                max_entries,
            };
        }

        if (!this.ai_review?.engine.includes("katago")) {
            this.setState({
                hide_table: true,
            });
            return {
                ai_table_rows: default_table_rows,
                avg_score_loss,
                median_score_loss,
                moves_pending: moves_missing,
                max_entries,
            };
        }

        const handicap = goban.engine.handicap;
        //only useful when there's free placement, handicap = 1 no offset needed.
        let h_offset = AIReviewClass.handicapOffset(goban);
        h_offset = h_offset === 1 ? 0 : h_offset;
        const b_player = h_offset > 0 || handicap > 1 ? 1 : 0;
        const move_player_list = AIReviewClass.getPlayerColorsMoveList(goban);

        if (this.ai_review?.type === "fast") {
            const scores = this.ai_review?.scores;
            const is_uploaded = goban.config.original_sgf !== undefined;
            //one more ai review point than moves in the game, since initial board gets a score.

            if (scores === undefined) {
                return {
                    ai_table_rows: default_table_rows,
                    avg_score_loss,
                    median_score_loss,
                    moves_pending: moves_missing,
                    max_entries,
                };
            }
            const check1 =
                !is_uploaded &&
                goban.config.moves?.length !== (this.ai_review?.scores?.length ?? -1) - 1;
            // extra initial ! in all_moves which matches extra empty board score, except in handicap games for some reason.
            // so subtract 1 if black goes second == b_player
            const check2 =
                is_uploaded &&
                (goban.config as any)["all_moves"]?.split("!").length - b_player !==
                    this.ai_review?.scores?.length;

            // if there's less than 4 moves the worst moves doesn't seem to return 3 moves, otherwise look for these three moves.
            const check3 =
                this.ai_review?.moves === undefined ||
                (Object.keys(this.ai_review?.moves).length !== 3 && scores.length > 4);
            if (check1 || check2 || check3) {
                return {
                    ai_table_rows: default_table_rows,
                    avg_score_loss,
                    median_score_loss,
                    moves_pending: moves_missing,
                    max_entries,
                };
            }

            // we don't need the first two rows, as they're for full reviews.
            ai_table_rows.splice(0, 2);
            summary_moves_list.splice(0, 2);
            const num_rows = ai_table_rows.length;
            const move_counters = Array(2 * num_rows).fill(0);
            const other_counters = Array(2).fill(0);
            let w_total = 0;
            let b_total = 0;
            const score_loss_list: [number[], number[]] = [[], []];
            const worst_move_keys = Object.keys(this.ai_review?.moves);

            for (let j = 0; j < worst_move_keys.length; j++) {
                (scores as any)[worst_move_keys[j]] =
                    this.ai_review?.moves[worst_move_keys[j]].score;
            }

            for (let j = h_offset; j < scores.length - 1; j++) {
                let score_diff = scores[j + 1] - scores[j];
                const is_b_player = move_player_list[j] === JGOFNumericPlayerColor.BLACK;
                const offset = is_b_player ? 0 : num_rows;
                const player_index = is_b_player ? 0 : 1;
                score_diff = is_b_player ? -1 * score_diff : score_diff;
                avg_score_loss[player_index] += score_diff;
                score_loss_list[player_index].push(score_diff);

                if (score_diff < 1) {
                    move_counters[offset] += 1;
                    //console.log("good");
                } else if (score_diff < 2) {
                    move_counters[offset + 1] += 1;
                    //console.log("inaccuracy");
                } else if (score_diff < 5) {
                    move_counters[offset + 2] += 1;
                    //console.log("mistake");
                } else if (score_diff >= 5) {
                    move_counters[offset + 3] += 1;
                    //console.log("blunder");
                } else {
                    other_counters[player_index] += 1;
                }
            }

            for (let j = 0; j < num_rows; j++) {
                b_total += move_counters[j];
                w_total += move_counters[num_rows + j];
            }

            avg_score_loss[0] = b_total > 0 ? Number((avg_score_loss[0] / b_total).toFixed(1)) : 0;
            avg_score_loss[1] = w_total > 0 ? Number((avg_score_loss[1] / w_total).toFixed(1)) : 0;

            score_loss_list[0].sort((a, b) => {
                return a - b;
            });
            score_loss_list[1].sort((a, b) => {
                return a - b;
            });

            median_score_loss[0] =
                this.medianList(score_loss_list[0]) !== undefined
                    ? Number(this.medianList(score_loss_list[0]).toFixed(1))
                    : 0;
            median_score_loss[1] =
                this.medianList(score_loss_list[1]) !== undefined
                    ? Number(this.medianList(score_loss_list[1]).toFixed(1))
                    : 0;

            for (let j = 0; j < num_rows; j++) {
                summary_moves_list[j][0] = move_counters[j].toString();
                summary_moves_list[j][1] =
                    b_total > 0 ? ((100 * move_counters[j]) / b_total).toFixed(1) : "";
                summary_moves_list[j][2] = move_counters[num_rows + j].toString();
                summary_moves_list[j][3] =
                    w_total > 0 ? ((100 * move_counters[num_rows + j]) / w_total).toFixed(1) : "";
            }

            for (let j = 0; j < ai_table_rows.length; j++) {
                ai_table_rows[j] = ai_table_rows[j].concat(summary_moves_list[j]);
            }

            this.setState({
                hide_table: true,
            });

            return {
                ai_table_rows,
                avg_score_loss,
                median_score_loss,
                moves_pending: moves_missing,
                max_entries,
            };
        } else if (this.ai_review?.type === "full") {
            const num_rows = ai_table_rows.length;
            const move_keys = Object.keys(this.ai_review?.moves);
            const is_uploaded = goban.config.original_sgf !== undefined;
            // should be one more ai review score and move branches for empty board.
            const check1 = !is_uploaded && goban.config.moves?.length !== move_keys.length - 1;
            // extra initial ! in all_moves which matches extra empty board score, except in handicap games for some reason.
            // so subtract 1 if black goes second == b_player
            const check2 =
                is_uploaded &&
                (goban.config as any)["all_moves"].split("!").length - b_player !==
                    move_keys.length;

            if (this.state.loading || this.ai_review.scores === undefined) {
                for (let j = 0; j < ai_table_rows.length; j++) {
                    ai_table_rows[j] = ai_table_rows[j].concat(summary_moves_list[j]);
                }
                return {
                    ai_table_rows,
                    avg_score_loss,
                    median_score_loss,
                    moves_pending: moves_missing,
                    max_entries,
                };
            }

            max_entries = this.ai_review.scores.length;
            const move_counters = Array(2 * num_rows).fill(0);
            const other_counters = Array(2).fill(0);
            let w_total = 0;
            let b_total = 0;
            const score_loss_list: [number[], number[]] = [[], []];

            for (let j = h_offset; j < this.ai_review?.scores.length - 1; j++) {
                if (
                    this.ai_review?.moves[j] === undefined ||
                    this.ai_review?.moves[j + 1] === undefined
                ) {
                    moves_missing += 1;
                    continue;
                }
                const player_move = this.ai_review?.moves[j + 1].move;
                //the current ai review shows top six playouts on the board, so matching that.
                const current_branches = this.ai_review?.moves[j].branches.slice(0, 6);
                const blue_move = current_branches[0].moves[0];
                const is_b_player = move_player_list[j] === JGOFNumericPlayerColor.BLACK;
                const offset = is_b_player ? 0 : num_rows;
                const player_index = is_b_player ? 0 : 1;
                let score_diff =
                    (this.ai_review?.moves[j + 1].score ?? 0) -
                    (this.ai_review?.moves[j].score ?? 0);
                score_diff = is_b_player ? -1 * score_diff : score_diff;
                avg_score_loss[player_index] += score_diff;
                score_loss_list[player_index].push(score_diff);

                if (blue_move === undefined) {
                    other_counters[player_index] += 1;
                } else if (player_move.x === -1) {
                    other_counters[player_index] += 1;
                    //console.log("pass etc");
                } else {
                    if (isEqualMoveIntersection(blue_move, player_move)) {
                        move_counters[offset] += 1;
                        //console.log("blue Excellent");
                    } else if (
                        current_branches.some((branch, index) => {
                            if (!branch.moves.length) {
                                return false;
                            }

                            const check =
                                index > 0 &&
                                isEqualMoveIntersection(branch.moves[0], player_move) &&
                                branch.visits >=
                                    Math.min(50, 0.1 * (this.ai_review?.strength ?? 0));
                            return check;
                        })
                    ) {
                        move_counters[offset + 1] += 1;
                        //console.log("green Great");
                    } else if (score_diff < 1) {
                        move_counters[offset + 2] += 1;
                        //console.log("good");
                    } else if (score_diff < 2) {
                        move_counters[offset + 3] += 1;
                        //console.log("inaccuracy");
                    } else if (score_diff < 5) {
                        move_counters[offset + 4] += 1;
                        //console.log("mistake");
                    } else if (score_diff >= 5) {
                        move_counters[offset + 5] += 1;
                        //console.log("blunder");
                    } else {
                        other_counters[player_index] += 1;
                    }
                }
            }

            for (let j = 0; j < num_rows; j++) {
                b_total += move_counters[j];
                w_total += move_counters[num_rows + j];
            }

            avg_score_loss[0] = b_total > 0 ? Number((avg_score_loss[0] / b_total).toFixed(1)) : 0;
            avg_score_loss[1] = w_total > 0 ? Number((avg_score_loss[1] / w_total).toFixed(1)) : 0;

            score_loss_list[0].sort((a, b) => {
                return a - b;
            });
            score_loss_list[1].sort((a, b) => {
                return a - b;
            });

            median_score_loss[0] =
                this.medianList(score_loss_list[0]) !== undefined
                    ? Number(this.medianList(score_loss_list[0]).toFixed(1))
                    : 0;
            median_score_loss[1] =
                this.medianList(score_loss_list[1]) !== undefined
                    ? Number(this.medianList(score_loss_list[1]).toFixed(1))
                    : 0;

            for (let j = 0; j < num_rows; j++) {
                summary_moves_list[j][0] = move_counters[j].toString();
                summary_moves_list[j][1] =
                    b_total > 0 ? ((100 * move_counters[j]) / b_total).toFixed(1) : "";
                summary_moves_list[j][2] = move_counters[num_rows + j].toString();
                summary_moves_list[j][3] =
                    w_total > 0 ? ((100 * move_counters[num_rows + j]) / w_total).toFixed(1) : "";
            }

            for (let j = 0; j < ai_table_rows.length; j++) {
                ai_table_rows[j] = ai_table_rows[j].concat(summary_moves_list[j]);
            }

            if (!check1 && !check2) {
                this.setState({
                    hide_table: true,
                });
            }

            return {
                ai_table_rows,
                avg_score_loss,
                median_score_loss,
                moves_pending: moves_missing,
                max_entries,
            };
        } else {
            return {
                ai_table_rows: default_table_rows,
                avg_score_loss,
                median_score_loss,
                moves_pending: moves_missing,
                max_entries,
            };
        }
    }

    public render(): React.ReactElement | null {
        if (this.state.loading) {
            return null;
        }

        const goban = this.props.gobanContext;

        if (!goban || !goban.engine) {
            return null;
        }

        if (!this.props.move) {
            return null;
        }

        if (!this.ai_review || this.props.hidden) {
            return (
                <div className="AIReview">
                    <UIPush
                        event="ai-review"
                        channel={`game-${this.props.game_id}`}
                        action={this.ai_review_update}
                    />
                    {this.state.selected_ai_review?.uuid && this.state.selected_ai_review?.id && (
                        <AIReviewStream
                            uuid={this.state.selected_ai_review?.uuid}
                            game_id={this.props.game_id}
                            ai_review_id={this.state.selected_ai_review?.id}
                            callback={this.updateAiReview}
                        />
                    )}
                    {((!this.props.hidden &&
                        this.state.ai_reviews.length === 0 &&
                        this.state.reviewing) ||
                        null) && (
                        <div className="reviewing">
                            <span>{_("Queuing AI review")}</span>
                            <i className="fa fa-desktop slowstrobe"></i>
                        </div>
                    )}
                </div>
            );
        }

        let show_full_ai_review_button: null | true = null;
        const user = data.get("user");

        try {
            if (
                user.id === game_control.creator_id ||
                user.id === goban.engine.players.black.id ||
                user.id === goban.engine.players.white.id
            ) {
                show_full_ai_review_button = true;
            } else if (
                user.is_moderator ||
                (user.moderator_powers & MODERATOR_POWERS.AI_DETECTOR) !== 0
            ) {
                show_full_ai_review_button = true;
            } else {
                show_full_ai_review_button = null;
            }
        } catch {
            // no problem, just someone else's sgf or something
            show_full_ai_review_button = null;
        }

        const [win_rate, score, _next_move_delta_win_rate, _next_move_pretty_coords] =
            this.updateHighlightsMarksAndHeatmaps();

        const win_rate_p = win_rate * 100.0;
        //const next_move_delta_p = (next_move_delta_win_rate ?? 0) * 100.0;

        const ai_review_chart_entries: Array<AIReviewEntry> =
            this.ai_review.win_rates?.map((x, idx) => {
                return {
                    move_number: idx,
                    win_rate: x,
                    score: this.ai_review?.moves[idx]?.score || 0,
                    num_variations: this.ai_review?.moves[idx]?.branches.length || 0,
                };
            }) || [];

        const ai_review_chart_variation_entries: Array<AIReviewEntry> =
            this.getVariationReviewEntries();

        const cur_move = this.props.move;
        const trunk_move = cur_move.getBranchPoint();
        const move_number = trunk_move.move_number;
        const variation_move_number =
            cur_move.move_number !== trunk_move.move_number ? cur_move.move_number : -1;

        let black_moves = 0;
        let white_moves = 0;

        let worst_move_list = getWorstMoves(goban.engine.move_tree, this.ai_review, 100);
        worst_move_list = worst_move_list.filter(
            (move) =>
                (move.player === 1 && black_moves++ < 3) ||
                (move.player === 2 && white_moves++ < 3),
        );
        worst_move_list.sort((a, b) => a.move_number - b.move_number);

        const show_become_supporter_text =
            !user.anonymous && !user.supporter && !user.is_moderator && !user.professional;

        console.log("ai review", this.props.reportContext);
        return (
            <div className="AIReview">
                <UIPush
                    event="ai-review"
                    channel={`game-${this.props.game_id}`}
                    action={this.ai_review_update}
                />
                {this.state.selected_ai_review?.uuid && this.state.selected_ai_review?.id && (
                    <AIReviewStream
                        uuid={this.state.selected_ai_review?.uuid}
                        game_id={this.props.game_id}
                        ai_review_id={this.state.selected_ai_review?.id}
                        callback={this.updateAiReview}
                    />
                )}

                {(this.state.ai_reviews.length >= 1 || null) && (
                    <Select
                        classNamePrefix="ogs-react-select"
                        value={this.state.selected_ai_review}
                        options={this.state.ai_reviews}
                        onChange={this.setSelectedAIReview as any}
                        isClearable={false}
                        blurInputOnSelect={true}
                        isSearchable={false}
                        components={{
                            Option: ({ innerRef, innerProps, isFocused, data, getValue }) => {
                                const value = getValue();
                                const isSelected = value && value[0].id === data.id;

                                return (
                                    <div
                                        ref={innerRef}
                                        {...innerProps}
                                        className={
                                            "ai-review-option-container " +
                                            (isFocused ? "focused " : "") +
                                            (isSelected ? "selected" : "")
                                        }
                                    >
                                        <ReviewStrengthIcon review={data} />
                                        <div className="ai-review-information">
                                            <div>
                                                {interpolate(
                                                    pgettext(
                                                        "AI Review technical information",
                                                        "{{engine}} {{engine_version}} using the {{network_size}} network {{network}}.",
                                                    ),
                                                    {
                                                        engine: engineName(data.engine),
                                                        engine_version: data.engine_version,
                                                        network_size: data.network_size,
                                                        network: extractShortNetworkVersion(
                                                            data.network,
                                                        ),
                                                    },
                                                )}
                                            </div>
                                            <div className="date">
                                                {moment(new Date(data.date)).format("lll")}
                                            </div>
                                        </div>
                                    </div>
                                );
                            },
                            SingleValue: ({ data }) => (
                                <React.Fragment>
                                    <ReviewStrengthIcon review={data} />
                                    {win_rate >= 0 && win_rate <= 1.0 ? (
                                        this.state.use_score && this.ai_review?.scores ? (
                                            <div className="progress">
                                                {score > 0 ? (
                                                    <div
                                                        className="progress-bar black-background"
                                                        style={{ width: "100%" }}
                                                    >
                                                        {interpolate(
                                                            pgettext(
                                                                "AI Review: Black ahead by {score}",
                                                                "B+{{score}}",
                                                            ),
                                                            { score: score.toFixed(1) },
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="progress-bar white-background"
                                                        style={{ width: "100%" }}
                                                    >
                                                        {interpolate(
                                                            pgettext(
                                                                "AI Review: White ahead by {score}",
                                                                "W+{{score}}",
                                                            ),
                                                            { score: (-score).toFixed(1) },
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="progress">
                                                <div
                                                    className="progress-bar black-background"
                                                    style={{ width: win_rate_p + "%" }}
                                                >
                                                    {win_rate_p.toFixed(1)}%
                                                </div>
                                                <div
                                                    className="progress-bar white-background"
                                                    style={{ width: 100.0 - win_rate_p + "%" }}
                                                >
                                                    {(100 - win_rate_p).toFixed(1)}%
                                                </div>
                                            </div>
                                        )
                                    ) : (
                                        <div className="pending">
                                            <i className="fa fa-desktop slowstrobe"></i>
                                            {_("Processing")}
                                        </div>
                                    )}
                                </React.Fragment>
                            ),
                            ValueContainer: ({ children }) => (
                                <div className="ai-review-win-rate-container">{children}</div>
                            ),
                            MenuList: (props) => {
                                //const goban = this.context;
                                //
                                const MenuList = components.MenuList as any;

                                return (
                                    <MenuList {...props}>
                                        {props.children}
                                        {show_full_ai_review_button && (
                                            <div className="ai-review-new-review">
                                                <button
                                                    onClick={() =>
                                                        this.startNewAIReview("full", "katago")
                                                    }
                                                >
                                                    <i className="fa fa-plus" /> KataGo
                                                </button>
                                                {/*
                                                ((goban?.width === 19 && goban.height === 19) ||
                                                    null) && (
                                                    <button
                                                        onClick={() =>
                                                            this.startNewAIReview(
                                                                "full",
                                                                "leela_zero",
                                                            )
                                                        }
                                                    >
                                                        <i className="fa fa-plus" /> Leela Zero
                                                    </button>
                                                )*/}
                                            </div>
                                        )}
                                    </MenuList>
                                );
                            },
                        }}
                    />
                )}

                {this.ai_review.error ? (
                    <React.Fragment>
                        <h3>{_("Error")}</h3>
                        <Errcode message={this.ai_review.error} />
                    </React.Fragment>
                ) : (
                    <React.Fragment>
                        {((this.ai_review && this.ai_review.win_rates) || null) && (
                            <React.Fragment>
                                <AIReviewChart
                                    ai_review={this.ai_review}
                                    entries={ai_review_chart_entries}
                                    variation_entries={ai_review_chart_variation_entries}
                                    update_count={this.state.update_count}
                                    move_number={move_number}
                                    variation_move_number={variation_move_number}
                                    set_move={(num: number) => game_control.emit("gotoMove", num)}
                                    use_score={this.state.use_score}
                                    highlighted_moves={worst_move_list
                                        .slice(0, this.state.worst_moves_shown)
                                        .map((m) => m.move_number - 1)}
                                />
                                <div className="worst-moves-summary-toggle-container">
                                    {this.renderWorstMoveList(worst_move_list)}
                                    {(user.is_moderator ||
                                        this.powerToSeeTable(
                                            this.props.reportContext?.moderator_powers,
                                        )) &&
                                        this.ai_review?.engine.includes("katago") && (
                                            <div className="ai-summary-toggler">
                                                <span>
                                                    <i className="fa fa-table"></i>
                                                </span>
                                                <span>
                                                    <Toggle
                                                        checked={this.state.table_hidden}
                                                        onChange={(b) => {
                                                            preferences.set(
                                                                "ai-summary-table-show",
                                                                b,
                                                            );
                                                            this.setState({ table_hidden: b });
                                                            //console.log(this.state.table_hidden);
                                                        }}
                                                    />
                                                </span>
                                            </div>
                                        )}
                                </div>
                                {this.ai_review.scores && (
                                    <div className="win-score-toggler">
                                        <span
                                            className="win-toggle"
                                            onClick={() => {
                                                preferences.set("ai-review-use-score", false);
                                                this.setState({ use_score: false });
                                            }}
                                        >
                                            {pgettext(
                                                "Display the win % that the AI estimates",
                                                "Win %",
                                            )}
                                        </span>

                                        <span>
                                            <Toggle
                                                checked={this.state.use_score}
                                                onChange={(b) => {
                                                    preferences.set("ai-review-use-score", b);
                                                    this.setState({ use_score: b });
                                                }}
                                            />
                                        </span>

                                        <span
                                            className="score-toggle"
                                            onClick={() => {
                                                preferences.set("ai-review-use-score", true);
                                                this.setState({ use_score: true });
                                            }}
                                        >
                                            {pgettext(
                                                "Display the game score that the AI estimates",
                                                "Score",
                                            )}
                                        </span>
                                    </div>
                                )}
                            </React.Fragment>
                        )}

                        {(this.ai_review?.type === "fast" || null) && (
                            <div className="key-moves">
                                {show_full_ai_review_button && (
                                    <div>
                                        <button
                                            className="primary"
                                            onClick={() => this.startNewAIReview("full", "katago")}
                                        >
                                            {_("Full AI Review")}
                                        </button>
                                        {(show_become_supporter_text || null) && (
                                            <div
                                                className="fakelink become-a-site-supporter-line"
                                                onClick={() =>
                                                    this.startNewAIReview("full", "katago")
                                                }
                                            >
                                                {_(
                                                    "Become a site supporter today for in-depth interactive AI reviews",
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </React.Fragment>
                )}

                {(!this.ai_review || null) && (
                    <div className="pending">
                        {_("AI review has been queued for processing.")}
                        <i className="fa fa-desktop slowstrobe"></i>
                    </div>
                )}

                {/*null && next_move_pretty_coords && next_move_delta_win_rate !== null && (
                    <div className="next-move-delta-container">
                        <span
                            className={
                                "next-move-coordinates " +
                                (goban.engine.colorToMove() === "white"
                                    ? "white-background"
                                    : "black-background")
                            }
                        >
                            <i className="ogs-label-triangle"></i> {next_move_pretty_coords}
                        </span>

                        <span
                            className={
                                "next-move-delta " +
                                (next_move_delta_p <= -0.1
                                    ? "negative"
                                    : next_move_delta_p >= 0.1
                                      ? "positive"
                                      : "")
                            }
                        >
                            {next_move_delta_p <= -0.1 ? (
                                <span>&minus;</span>
                            ) : next_move_delta_p >= 0.1 ? (
                                <span>&#43;</span>
                            ) : (
                                <span>&nbsp;&nbsp;</span>
                            )}{" "}
                            {Math.abs(next_move_delta_p).toFixed(1)}pp
                        </span>
                    </div>
                )*/}
                {(data.get("user").is_moderator ||
                    this.powerToSeeTable(this.props.reportContext?.moderator_powers)) &&
                    this.ai_review?.engine.includes("katago") && (
                        <div>
                            <AiSummaryTable
                                heading_list={[_("Type"), _("Black"), "%", _("White"), "%"]}
                                body_list={this.table_rows}
                                avg_loss={this.avg_score_loss}
                                median_score_loss={this.median_score_loss}
                                table_hidden={this.state.table_hidden}
                                pending_entries={this.moves_pending}
                                max_entries={this.max_entries}
                            />
                        </div>
                    )}
            </div>
        );
    }

    public renderWorstMoveList(lst: AIReviewWorstMoveEntry[]): React.ReactElement | null {
        const goban = this.props.gobanContext;
        if (!goban?.engine.move_tree || !this.ai_review) {
            return null;
        }

        const more_ct = Math.max(0, lst.length - this.state.worst_moves_shown);

        /* {pgettext("Moves that were the biggest mistakes, according to the AI", "Key moves")}: */

        return (
            <div className="worst-move-list-container">
                <div className="move-list">
                    {lst.slice(0, this.state.worst_moves_shown).map((de, idx) => {
                        const pretty_coords = goban.engine.prettyCoordinates(de.move.x, de.move.y);
                        return (
                            <span
                                key={`${idx}-${de.move_number}`}
                                className={
                                    de.player === JGOFNumericPlayerColor.BLACK
                                        ? "move black-background"
                                        : "move white-background"
                                }
                                onClick={() => game_control.emit("gotoMove", de.move_number - 1)}
                            >
                                {pretty_coords}
                            </span>
                        );
                    })}
                    {(more_ct > 0 || null) && (
                        <span>
                            {interpolate(
                                pgettext(
                                    "Number of big mistake moves not listed",
                                    "+ {{more_ct}} more",
                                ),
                                {
                                    more_ct,
                                },
                            )}
                        </span>
                    )}
                </div>
            </div>
        );
    }
}

function sanityCheck(ai_review: JGOFAIReview) {
    if (ai_review.moves["0"]) {
        if (ai_review.moves["0"].move.x !== -1) {
            console.error("AI Review move '0' is not a pass move, was ", ai_review.moves["0"].move);
        }
    }
    if (typeof ai_review.moves !== "object") {
        console.error("AI Review moves was not an object", JSON.stringify(ai_review.moves));
    }
}

function isEqualMoveIntersection(a: JGOFIntersection, b: JGOFIntersection): boolean {
    return a.x === b.x && a.y === b.y;
}
export function ReviewStrengthIcon({
    review,
}: {
    review: JGOFAIReview | rest_api.AIReviewParams;
}): React.ReactElement {
    let strength: string;
    let content = "";
    if (review.type === "fast") {
        strength = "ai-review-fast";
        content = "";
    } else {
        if (review.network_size === "20x256") {
            if (review.strength >= 10000) {
                strength = "ai-review-strength-4";
                content = "IV";
            } else if (review.strength >= 1600) {
                strength = "ai-review-strength-3";
                content = "III";
            } else if (review.strength >= 800) {
                strength = "ai-review-strength-2";
                content = "II";
            } else if (review.strength >= 300) {
                strength = "ai-review-strength-1";
                content = "I";
            } else {
                strength = "ai-review-strength-0";
                content = "";
            }
        } else {
            if (review.strength >= 6000) {
                strength = "ai-review-strength-4";
                content = "IV";
            } else if (review.strength >= 1500) {
                strength = "ai-review-strength-3";
                content = "III";
            } else if (review.strength >= 500) {
                strength = "ai-review-strength-2";
                content = "II";
            } else if (review.strength >= 200) {
                strength = "ai-review-strength-1";
                content = "I";
            } else {
                strength = "ai-review-strength-0";
                content = "";
            }
        }
    }

    return <span className={"ai-review-strength-icon " + strength}>{content}</span>;
}
function engineName(engine: string) {
    switch (engine) {
        case "leela_zero":
            return "Leela Zero";
        case "katago":
        case "katago:fast":
        case "katago:meijin":
            return "KataGo";
    }
    console.warn("Unknown engine name", engine);
    return "AI";
}
function extractShortNetworkVersion(network: string): string {
    // the first part of the katago version describes the network size,
    // second/third is hash I think
    if (network.indexOf("-") > 0) {
        network = network.match(/[^-]*[-]([^-]*)/)?.[1] || "xxxxxx";
    }
    return network.substr(0, 6);
}

class AiSummaryTable extends React.Component<AiSummaryTableProperties, AiSummaryTableState> {
    constructor(props: AiSummaryTableProperties) {
        super(props);
    }

    render(): React.ReactElement {
        return (
            <div className="ai-summary-container">
                <table
                    className="ai-summary-table"
                    style={{ display: this.props.table_hidden ? "block" : "none" }}
                >
                    <thead>
                        <tr>
                            {this.props.heading_list.map((head, index) => {
                                return <th key={index}>{head}</th>;
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {this.props.body_list.map((body, b_index) => {
                            return (
                                <tr key={b_index}>
                                    {body.map((element, e_index) => {
                                        return <td key={e_index}>{element}</td>;
                                    })}
                                </tr>
                            );
                        })}
                        {this.props.pending_entries > 0 && (
                            <React.Fragment>
                                <tr>
                                    <td colSpan={2}>{"Moves Pending"}</td>
                                    <td colSpan={3}>{this.props.pending_entries}</td>
                                </tr>
                                <tr>
                                    <td colSpan={5}>
                                        <progress
                                            value={
                                                this.props.max_entries - this.props.pending_entries
                                            }
                                            max={this.props.max_entries}
                                        ></progress>
                                    </td>
                                </tr>
                            </React.Fragment>
                        )}
                        <tr>
                            <td colSpan={5}>{"Average score loss per move"}</td>
                        </tr>
                        <tr>
                            <td colSpan={2}>{"Black"}</td>
                            <td colSpan={3}>{this.props.avg_loss[0]}</td>
                        </tr>
                        <tr>
                            <td colSpan={2}>{"White"}</td>
                            <td colSpan={3}>{this.props.avg_loss[1]}</td>
                        </tr>
                        <tr>
                            <td colSpan={5}>{"Median score loss per move"}</td>
                        </tr>
                        <tr>
                            <td colSpan={2}>{"Black"}</td>
                            <td colSpan={3}>{this.props.median_score_loss[0]}</td>
                        </tr>
                        <tr>
                            <td colSpan={2}>{"White"}</td>
                            <td colSpan={3}>{this.props.median_score_loss[1]}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        );
    }
}

interface AiSummaryTableState {}

interface AiSummaryTableProperties {
    /** headings for ai review table */
    heading_list: string[];
    /** the body of the table excluding the average score loss part */
    body_list: string[][];
    /** values for the average score loss */
    avg_loss: number[];
    median_score_loss: number[];
    table_hidden: boolean;
    pending_entries: number;
    max_entries: number;
}
